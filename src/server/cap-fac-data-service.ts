import { OEClientQueued } from './queued-oeclient';
import {
  FleetMode,
  GeneratingUnitCapFacHistoryDTO,
  GeneratingUnitDTO
} from '@/shared/types';
import { CalendarDate, parseDate } from '@internationalized/date';
import { getAESTDateTimeString, networkDayFromInterval, getTodayAEST } from '@/shared/date-utils';
import { NoDataFound, type NetworkCode } from 'openelectricity';

// A single coal generating unit as returned by the facilities endpoint.
interface UnitRecord {
  facility_code: string;
  facility_name: string;
  facility_network: string;
  facility_region: string;
  unit_code: string;
  unit_fueltech: string;
  // Registered capacity in MW. Can be null in the OpenElectricity metadata
  // (rare for coal, but possible for some retired units), so callers must guard
  // the capacity-factor division and row-height maths against null.
  unit_capacity: number | null;
  // Operating status ('operating' | 'retired') and the last day the unit had
  // data, from the /facilities endpoint. Used to emit 0 (generated nothing,
  // i.e. decommissioned) rather than null for a retired unit's days after it
  // stopped — see the fill loop in processGeneratingUnitCapFacHistoryDTO.
  unit_status: string | null;
  unit_last_seen: string | null;
}

interface Facility {
  facility_code: string;
  facility_name: string;
  facility_network: string;
  facility_region: string;
  units: UnitRecord[];
}

// One daily energy reading for a unit. `energy` is null when there is no data
// for that day (distinct from 0, which means the unit generated nothing).
interface EnergyRow {
  interval: Date;
  unit_code: string;
  energy: number | null;
}

// Opt-in verbose logging: set DEBUG_OE=1 to trace fetches/caching locally.
const debug = (...args: unknown[]): void => {
  if (process.env.DEBUG_OE) console.log(...args);
};

// The OpenElectricity SDK throws NoDataFound (HTTP 404) when a query's date
// range has no data at all — e.g. the WEM network before 2006, or a retired
// unit queried for a year it didn't operate. That's an expected, tolerable
// condition per network; every other error (auth 403, rate limit, 5xx) throws
// OpenElectricityError and must stay fatal so the route can surface it.
const isNoData = (err: unknown): boolean => err instanceof NoDataFound;

/**
 * The heart of the OpenElectricity integration. For a given calendar year this
 * service:
 *
 *   1. fetches all operating coal units from the facilities endpoint (once,
 *      cached for the life of the instance),
 *   2. fetches each network's daily energy data for the year, and
 *   3. converts energy (MWh/day) into capacity factors (% of what the unit
 *      could have generated at its registered capacity), preserving the
 *      null-vs-zero distinction: 0 = the unit generated nothing, null = no
 *      data (future dates, or gaps in the collection infrastructure).
 *
 * Year results are NOT cached here — the route's unstable_cache (Vercel Data
 * Cache) owns that, with revision-aware freshness tiers (see yearCachePolicy
 * in @/shared/config). An in-process copy would silently defeat revalidation
 * on a warm instance. Only the facilities list is memoised, with a TTL so new
 * or retired units appear within a day.
 */
const FACILITIES_TTL_MS = 24 * 60 * 60 * 1000;

export class CapFacDataService {
  private client: OEClientQueued;
  // Facilities are memoised per fleet mode: `full` (operating + retired) and
  // `current` (operating only) are different rosters, so they can't share a
  // cache slot.
  private facilitiesCache = new Map<FleetMode, Facility[]>();
  private facilitiesFetchedAt = new Map<FleetMode, number>();
  private facilitiesFetchPromise = new Map<FleetMode, Promise<Facility[]>>();

  constructor(apiKey: string) {
    this.client = new OEClientQueued(apiKey);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Wait for any pending facility fetches (across modes) to complete
    try {
      await Promise.all(this.facilitiesFetchPromise.values());
    } catch {
      // Ignore errors during cleanup
    }

    // Clear caches and any pending requests
    this.facilitiesCache.clear();
    this.facilitiesFetchedAt.clear();
    this.facilitiesFetchPromise.clear();
    this.client.clearQueue();
  }

  /**
   * Fetch capacity factors for coal units for a specific year.
   * Always returns data for the full year with today and future dates nulled out.
   */
  async getCapacityFactors(year: number, mode: FleetMode): Promise<GeneratingUnitCapFacHistoryDTO> {
    const startTime = performance.now();

    // Always work with full years - no partial years allowed.
    // The API's daily interval allows a 366-day range, so a full leap year
    // fits in a single request (no splitting needed).
    const startDate = parseDate(`${year}-01-01`);
    const endDate = parseDate(`${year}-12-31`);
    debug(`📡 API fetch: ${year} (${mode})`);

    const facilities = await this.getAllCoalFacilities(mode);
    const energyData = await this.fetchEnergyData(
      facilities,
      startDate.toString(),
      endDate.toString()
    );

    const coalStripesData = this.processGeneratingUnitCapFacHistoryDTO(
      energyData,
      facilities,
      startDate,
      endDate,
      mode
    );

    const elapsed = Math.round(performance.now() - startTime);
    debug(`✅ API response: ${year} (${mode}) | ${elapsed}ms`);

    return coalStripesData;
  }

  /**
   * Get all coal facilities from OpenElectricity API
   */
  private async getAllCoalFacilities(mode: FleetMode): Promise<Facility[]> {
    // Return cached facilities while fresh; the TTL lets new or retired units
    // appear within a day on a long-lived warm instance.
    const cached = this.facilitiesCache.get(mode);
    if (cached && Date.now() - (this.facilitiesFetchedAt.get(mode) ?? 0) < FACILITIES_TTL_MS) {
      return cached;
    }

    // Return existing promise if a fetch for this mode is in progress
    const inFlight = this.facilitiesFetchPromise.get(mode);
    if (inFlight) {
      return inFlight;
    }

    // Start new fetch
    const promise = (async () => {
      try {
        debug(`🏭 Fetching coal facilities (${mode})...`);
        // The key OpenElectricity facilities query: filter the /facilities
        // endpoint down to coal units. `full` mode also includes retired
        // plants so history shows the fleet that actually operated then;
        // `current` mode is operating units only. We exclude 'committed' —
        // units that never generated. Other filters (e.g. gas, wind) work the
        // same way — see the fueltech and status ids in the OpenElectricity docs.
        const { table } = await this.client.getFacilities({
          status_id: mode === 'full' ? ['operating', 'retired'] : ['operating'],
          fueltech_id: ['coal_black', 'coal_brown']
        });

        const units = table.getRecords() as unknown as UnitRecord[];

        // Group units by facility
        const facilityMap = new Map<string, Facility>();
        for (const unit of units) {
          let facility = facilityMap.get(unit.facility_code);
          if (!facility) {
            facility = {
              facility_code: unit.facility_code,
              facility_name: unit.facility_name,
              facility_network: unit.facility_network,
              facility_region: unit.facility_region,
              units: []
            };
            facilityMap.set(unit.facility_code, facility);
          }
          facility.units.push(unit);
        }

        // Convert to array and sort by name
        const facilities = Array.from(facilityMap.values()).sort((a, b) =>
          a.facility_name.localeCompare(b.facility_name)
        );

        this.facilitiesCache.set(mode, facilities);
        this.facilitiesFetchedAt.set(mode, Date.now());
        debug(`🏭 Found ${facilities.length} coal facilities with ${units.length} units (${mode})`);

        return facilities;
      } finally {
        this.facilitiesFetchPromise.delete(mode);
      }
    })();

    this.facilitiesFetchPromise.set(mode, promise);
    return promise;
  }

  /**
   * Fetch daily energy data for the given facilities and date range.
   * `endDate` is inclusive; the API treats dateEnd as exclusive, so we add a day.
   */
  private async fetchEnergyData(
    facilities: Facility[],
    startDate: string,
    endDate: string
  ): Promise<EnergyRow[]> {
    // Group facility codes by network code
    const facilitiesByNetwork = new Map<string, string[]>();
    for (const facility of facilities) {
      const codes = facilitiesByNetwork.get(facility.facility_network) ?? [];
      if (!codes.includes(facility.facility_code)) {
        codes.push(facility.facility_code);
      }
      facilitiesByNetwork.set(facility.facility_network, codes);
    }

    debug(
      `   Fetching data for ${facilities.length} facilities across ${facilitiesByNetwork.size} networks...`
    );

    // The API treats dateEnd as exclusive, so add a day to include `endDate`.
    const dateEnd = parseDate(endDate).add({ days: 1 }).toString();

    const responses = await Promise.all(
      Array.from(facilitiesByNetwork, ([network, facilityCodes]) => {
        debug(`   Fetching ${network} network: ${facilityCodes.length} facilities`);
        // The key OpenElectricity time-series query: daily ('1d') energy in
        // MWh for every listed facility, one request per network. Dates are
        // interpreted in the network's local time (AEST for NEM, AWST for
        // WEM); see networkDayFromInterval for how rows map back to days.
        return this.client
          .getFacilityData(network as NetworkCode, facilityCodes, ['energy'], {
            interval: '1d',
            dateStart: startDate,
            dateEnd
          })
          .catch((err: unknown) => {
            // A network with no data for the range (e.g. WEM before 2006, or
            // NEM before it began in Dec 1998) is expected — tolerate it as an
            // empty result so one dataless network doesn't fail the whole year.
            // Every other error (auth, rate limit, 5xx) stays fatal.
            if (isNoData(err)) {
              debug(`   No data for ${network} in range (tolerated)`);
              return null;
            }
            debug(`   Failed to fetch ${network} data:`, err);
            throw err;
          });
      })
    );

    const rows: EnergyRow[] = [];
    for (const response of responses) {
      if (!response) continue; // network had no data for the range (tolerated)
      for (const row of response.datatable?.getRows() ?? []) {
        rows.push({
          interval: row.interval,
          unit_code: String(row.unit_code),
          energy: typeof row.energy === 'number' ? row.energy : null
        });
      }
    }

    debug(`   Received ${rows.length} data points`);
    return rows;
  }

  /**
   * Process raw energy data into GeneratingUnitCapFacHistoryDTO format
   */
  private processGeneratingUnitCapFacHistoryDTO(
    data: EnergyRow[],
    facilities: Facility[],
    requestedStartDate: CalendarDate,
    requestedEndDate: CalendarDate,
    mode: FleetMode
  ): GeneratingUnitCapFacHistoryDTO {
    const startTime = performance.now();

    // Sort facilities by network (NEM before WEM), then region, then name.
    const sortedFacilities = [...facilities].sort((a, b) => {
      const networkCompare = a.facility_network.localeCompare(b.facility_network);
      if (networkCompare !== 0) return networkCompare;
      const regionCompare = (a.facility_region || '').localeCompare(b.facility_region || '');
      if (regionCompare !== 0) return regionCompare;
      return a.facility_name.localeCompare(b.facility_name);
    });

    // "Today" in NEM time — today and future days are always null (unknown).
    const todayBrisbane = getTodayAEST();
    const coalUnits: GeneratingUnitDTO[] = [];

    for (const facility of sortedFacilities) {
      const sortedUnits = [...facility.units].sort((a, b) =>
        a.unit_code.localeCompare(b.unit_code)
      );

      for (const unit of sortedUnits) {
        const unitData = data.filter((row) => row.unit_code === unit.unit_code);
        // In `full` mode we emit a row for every roster unit even when it has
        // no data this year (retired units, or years before it was
        // commissioned) — the fill loop below yields an all-null history that
        // renders as the "no data" pale blue. In `current` mode we keep the
        // historical behaviour of dropping units with no data for the year.
        if (unitData.length === 0 && mode !== 'full') {
          continue;
        }

        // Registered capacity in MW; can be null (rare for coal). Guard the
        // capacity-factor division so it can't produce Infinity/NaN, and emit a
        // finite `capacity` so the client's row-height maths stay finite.
        const capacity = unit.unit_capacity;

        // Map each reading to its network-local calendar day for quick lookup.
        const dataByDay = new Map<string, EnergyRow>(
          unitData.map((row) => [
            networkDayFromInterval(row.interval, facility.facility_network).toString(),
            row
          ])
        );

        // A retired unit is switched off after its last day of data: emit 0
        // (generated nothing) there rather than null, so the client can tell a
        // decommissioned unit (red 0%) apart from one with no data yet or a
        // collection gap (null). Not-yet-commissioned days and gaps stay null.
        const decommissionedAfter =
          unit.unit_status === 'retired' && unit.unit_last_seen
            ? parseDate(unit.unit_last_seen.slice(0, 10))
            : null;

        // Fill the full requested range; missing/today/future days are null,
        // except a retired unit's post-shutdown days, which are 0.
        const capacityFactors: (number | null)[] = [];
        let currentDate = requestedStartDate;
        while (currentDate.compare(requestedEndDate) <= 0) {
          const dayData = dataByDay.get(currentDate.toString());
          if (decommissionedAfter && currentDate.compare(decommissionedAfter) > 0) {
            capacityFactors.push(0);
          } else if (currentDate.compare(todayBrisbane) >= 0) {
            capacityFactors.push(null);
          } else if (dayData && dayData.energy !== null && capacity && capacity > 0) {
            // capacity factor = (energy_MWh / 24h) / registered_capacity * 100
            const capacityFactor = (dayData.energy / 24) / capacity * 100;
            capacityFactors.push(Math.round(capacityFactor * 10) / 10);
          } else {
            capacityFactors.push(null);
          }
          currentDate = currentDate.add({ days: 1 });
        }

        coalUnits.push({
          network: facility.facility_network.toLowerCase(),
          region: facility.facility_region || undefined,
          data_type: 'energy',
          units: 'MW',
          capacity: capacity ?? 0,
          duid: unit.unit_code,
          facility_code: facility.facility_code,
          facility_name: facility.facility_name,
          fueltech: unit.unit_fueltech === 'coal_brown' ? 'coal_brown' : 'coal_black',
          history: {
            start: requestedStartDate.toString(),
            last: requestedEndDate.toString(),
            interval: '1d',
            data: capacityFactors
          }
        });
      }
    }

    debug(`   Processing completed in ${Math.round(performance.now() - startTime)}ms`);

    return {
      type: 'capacity_factors',
      version: '1.0',
      created_at: getAESTDateTimeString(),
      data: coalUnits
    };
  }
}
