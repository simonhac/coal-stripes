import { OEClientQueued } from './queued-oeclient';
import {
  GeneratingUnitCapFacHistoryDTO,
  GeneratingUnitDTO,
  UnitDateSpecificity
} from '@/shared/types';
import { CalendarDate, parseDate } from '@internationalized/date';
import { getAESTDateTimeString, networkDayFromInterval, getTodayAEST } from '@/shared/date-utils';
import { NoDataFound, type NetworkCode } from 'openelectricity';
import { envFlag, readEnv } from '@/server/runtime-env';

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
  // stopped — see the fill loop in processGeneratingUnitCapFacHistoryDTO — and
  // carried through to the DTO as `status`, which is what lets the client
  // derive the `current` fleet view without a second request.
  unit_status: string | null;
  unit_last_seen: string | null;
  unit_first_seen: string | null;
  // When the unit was commissioned, and how precisely OpenElectricity knows it.
  // Distinct from unit_first_seen (the data frontier) and often much later: the
  // market registers a DUID months before it can generate, and reports a real 0
  // for every day in between. MPP_1's series starts 2001-05-15, 178 days before
  // its own commencement_date. Only trusted when the specificity is 'day'.
  commencement_date: string | null;
  commencement_date_specificity: UnitDateSpecificity | null;
}

// Aggregate DUIDs: one market identifier metering a whole station rather than a
// machine. AEMO registers Playford B as a single aggregated dispatch unit
// (PLAYB-AG, physical units 1-4, Aggregation = Y, 240 MW), and from 1999-05-26
// OpenElectricity returns no rows at all for the four per-unit DUIDs — they were
// not switched off, they stopped being separately metered.
//
// Two consequences, both handled below. The members must not get the retired
// unit's synthetic 0-fill (it would paint thirteen years of "ran and generated
// nothing" over a station that was being metered perfectly well), and they must
// not be emitted as rows of their own (a 240 MW station drawn as 480 MW). Their
// readings are folded into the aggregate's row instead; the 5-minute interval
// data shows the handover is a clean cutover — the last unit interval is
// 1999-05-26 05:45 and the aggregate's first is 10:20 — so summing double-counts
// nothing. This is the only aggregate DUID in the coal fleet.
// The one roster we ever fetch: everything that operated across recorded
// history. 'committed' units — registered but never generating — are excluded.
const WANTED_STATUS = ['operating', 'retired'] as const;

const SUPERSEDED_BY: Readonly<Record<string, string>> = {
  PLAYFB1: 'PLAYB-AG',
  PLAYFB2: 'PLAYB-AG',
  PLAYFB3: 'PLAYB-AG',
  PLAYFB4: 'PLAYB-AG'
};

// OpenElectricity's lifecycle timestamps carry a network-local offset
// ('1999-05-26T00:00:00+10:00'); we only ever want the calendar day.
const asDate = (stamp: string | null | undefined): string | null =>
  stamp ? stamp.slice(0, 10) : null;

/**
 * The record holding the earliest (or latest) of some date field, so the value
 * and its companions — a commencement date and its specificity — stay together.
 * Records with no date are ignored; undefined when none has one.
 */
function earliestBy<T>(records: T[], date: (r: T) => string | null): T | undefined {
  return records
    .filter((r) => date(r))
    .sort((a, b) => (date(a) as string).localeCompare(date(b) as string))[0];
}

function latestBy<T>(records: T[], date: (r: T) => string | null): T | undefined {
  return records
    .filter((r) => date(r))
    .sort((a, b) => (date(a) as string).localeCompare(date(b) as string))
    .pop();
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
  if (envFlag('DEBUG_OE')) console.log(...args);
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
 * Year results are NOT cached or deduplicated here — @/server/cf-cache owns
 * both, with revision-aware freshness tiers (see yearCachePolicy in
 * @/shared/config). An in-process copy would silently defeat revalidation on a
 * warm instance. Every call to getCapacityFactors below is therefore a real
 * upstream fan-out, which is what lets cf-cache count cold fetches honestly.
 * Only the facilities list is memoised, with a TTL so new or retired units
 * appear within a day.
 *
 * There is exactly ONE roster: every unit that ever operated, each tagged with
 * its `status`. The `current` fleet view (operating units only) is a client-side
 * filter over this payload — see @/shared/fleet-filter. It used to be a second
 * upstream query and a second copy of every cache entry.
 */
const FACILITIES_TTL_MS = 24 * 60 * 60 * 1000;

export class CapFacDataService {
  private client: OEClientQueued;
  // The single memoised roster (operating + retired), refreshed on the TTL.
  private facilitiesCache: Facility[] | null = null;
  private facilitiesFetchedAt = 0;
  private facilitiesFetchPromise: Promise<Facility[]> | null = null;

  constructor(apiKey: string) {
    this.client = new OEClientQueued(apiKey);
  }

  /**
   * Drop the memoised facilities roster so the next request re-reads unit
   * metadata (capacities, commissioning/retirement dates) from OpenElectricity.
   *
   * Deliberately narrower than cleanup(): it leaves the request queue intact, so
   * it is safe to call on a live instance serving traffic. Used by the purge
   * endpoint, since this memo is the one data cache that revalidateTag cannot
   * reach. It only affects THIS serverless instance — other warm instances keep
   * their copy until the 24 h TTL expires.
   */
  clearFacilitiesCache(): void {
    this.facilitiesCache = null;
    this.facilitiesFetchedAt = 0;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Wait for any pending facility fetch to complete
    try {
      await this.facilitiesFetchPromise;
    } catch {
      // Ignore errors during cleanup
    }

    // Clear caches and any pending requests
    this.facilitiesCache = null;
    this.facilitiesFetchedAt = 0;
    this.facilitiesFetchPromise = null;
    this.client.clearQueue();
  }

  /**
   * Fetch capacity factors for coal units for a specific year.
   * Always returns data for the full year with today and future dates nulled out.
   */
  async getCapacityFactors(year: number): Promise<GeneratingUnitCapFacHistoryDTO> {
    const startTime = performance.now();

    // Always work with full years - no partial years allowed.
    // The API's daily interval allows a 366-day range, so a full leap year
    // fits in a single request (no splitting needed).
    const startDate = parseDate(`${year}-01-01`);
    const endDate = parseDate(`${year}-12-31`);
    debug(`📡 API fetch: ${year}`);

    const facilities = await this.getAllCoalFacilities();
    const energyData = await this.fetchEnergyData(
      facilities,
      startDate.toString(),
      endDate.toString()
    );

    const coalStripesData = this.processGeneratingUnitCapFacHistoryDTO(
      energyData,
      facilities,
      startDate,
      endDate
    );

    const elapsed = Math.round(performance.now() - startTime);
    debug(`✅ API response: ${year} | ${elapsed}ms`);

    return coalStripesData;
  }

  /**
   * Get all coal facilities from OpenElectricity API
   */
  private async getAllCoalFacilities(): Promise<Facility[]> {
    // Return cached facilities while fresh; the TTL lets new or retired units
    // appear within a day on a long-lived warm instance.
    if (this.facilitiesCache && Date.now() - this.facilitiesFetchedAt < FACILITIES_TTL_MS) {
      return this.facilitiesCache;
    }

    // Return existing promise if a fetch is already in progress
    if (this.facilitiesFetchPromise) {
      return this.facilitiesFetchPromise;
    }

    // Start new fetch
    const promise = (async () => {
      try {
        debug(`🏭 Fetching coal facilities...`);
        // The key OpenElectricity facilities query: filter the /facilities
        // endpoint down to coal units. Retired plants are included so history
        // shows the fleet that actually operated then; the `current` view drops
        // them client-side using the `status` we emit per unit. We exclude
        // 'committed' — units that never generated. Other filters (e.g. gas,
        // wind) work the same way — see the fueltech and status ids in the
        // OpenElectricity docs.
        const result = await this.client.getFacilities({
          status_id: [...WANTED_STATUS],
          fueltech_id: ['coal_black', 'coal_brown']
        });

        // Read the response envelope rather than the flattened `table`. Both
        // come back in the same call, but the flattened IFacilityRecord drops
        // commencement_date — the one field that says when a unit was actually
        // commissioned, as opposed to when its DUID started reporting zeros.
        // The API filters are re-applied here because the envelope nests every
        // unit under its facility, and a facility matching on one unit would
        // otherwise drag in its non-coal or never-commissioned siblings. Only a
        // unit that positively contradicts the filter is dropped — the API's own
        // filtering stays authoritative for anything it left unlabelled.
        const units: UnitRecord[] = result.response.data.flatMap((facility) =>
          facility.units
            .filter(
              (unit) =>
                (unit.fueltech_id === null ||
                  unit.fueltech_id === 'coal_black' ||
                  unit.fueltech_id === 'coal_brown') &&
                (unit.status_id === null ||
                  (WANTED_STATUS as readonly string[]).includes(unit.status_id))
            )
            .map((unit) => ({
              facility_code: facility.code,
              facility_name: facility.name,
              facility_network: facility.network_id,
              facility_region: facility.network_region,
              unit_code: unit.code,
              unit_fueltech: unit.fueltech_id as string,
              unit_capacity: unit.capacity_registered,
              unit_status: unit.status_id,
              unit_last_seen: unit.data_last_seen ?? null,
              unit_first_seen: unit.data_first_seen ?? null,
              commencement_date: unit.commencement_date ?? null,
              commencement_date_specificity:
                (unit.commencement_date_specificity as UnitDateSpecificity | null) ?? null
            }))
        );

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

        this.facilitiesCache = facilities;
        this.facilitiesFetchedAt = Date.now();
        debug(`🏭 Found ${facilities.length} coal facilities with ${units.length} units`);

        return facilities;
      } finally {
        this.facilitiesFetchPromise = null;
      }
    })();

    this.facilitiesFetchPromise = promise;
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
    requestedEndDate: CalendarDate
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

      // Units absorbed into an aggregate DUID (see SUPERSEDED_BY) never get a
      // row of their own; their readings are folded into the aggregate's.
      const absorbedBy = new Map<string, UnitRecord[]>();
      for (const unit of sortedUnits) {
        const aggregate = SUPERSEDED_BY[unit.unit_code];
        if (!aggregate) continue;
        const siblings = absorbedBy.get(aggregate) ?? [];
        siblings.push(unit);
        absorbedBy.set(aggregate, siblings);
      }

      for (const unit of sortedUnits) {
        if (SUPERSEDED_BY[unit.unit_code]) continue;

        // The DUIDs whose readings make up this row: the unit itself, plus any
        // it supersedes. They are disjoint in time, so summing them reconstructs
        // one continuous station series across the metering change.
        const absorbed = absorbedBy.get(unit.unit_code) ?? [];
        const sources = [unit, ...absorbed];
        const sourceCodes = new Set(sources.map((u) => u.unit_code));
        const unitData = data.filter((row) => sourceCodes.has(row.unit_code));
        // We emit a row for every roster unit even when it has no data this
        // year (retired units, or years before it was commissioned) — the fill
        // loop below yields an all-null history that renders as the "no data"
        // pale blue. The `current` view drops those rows client-side; that it
        // can recognise them by their all-null history is exactly why this
        // emits them unconditionally. See @/shared/fleet-filter.

        // Registered capacity in MW; can be null (rare for coal). Guard the
        // capacity-factor division so it can't produce Infinity/NaN, and emit a
        // finite `capacity` so the client's row-height maths stay finite. An
        // aggregate is already registered at the whole station's capacity, so
        // the absorbed members add nothing here.
        const capacity = unit.unit_capacity;

        // Total energy per network-local calendar day across the row's DUIDs.
        // A day is null only when none of them reported: where some did and
        // others did not, the silent ones count as 0. That is a deliberate
        // exception to the null-is-not-zero rule, and it is confined to the one
        // facility that needs it — Playford B's four unit DUIDs, which are only
        // ever partially metered over the broken early-1999 window. It biases
        // the station low (on those days the metered units were nearly always
        // running, so their silent siblings probably were too) rather than
        // inventing output for a unit nobody measured.
        const dataByDay = new Map<string, number | null>();
        for (const row of unitData) {
          const day = networkDayFromInterval(row.interval, facility.facility_network).toString();
          const running = dataByDay.get(day);
          if (row.energy === null) {
            if (running === undefined) dataByDay.set(day, null);
          } else {
            dataByDay.set(day, (running ?? 0) + row.energy);
          }
        }

        // A retired unit is switched off after its last day of data: emit 0
        // (generated nothing) there rather than null, so the client can tell a
        // decommissioned unit (red 0%) apart from one with no data yet or a
        // collection gap (null). `decommissionedAfter` is its last day of data.
        const decommissionedAfter =
          unit.unit_status === 'retired' && unit.unit_last_seen
            ? parseDate(unit.unit_last_seen.slice(0, 10))
            : null;

        // The market registers a DUID before the machine can generate and
        // reports a real 0 for every day in between — 178 days for Millmerran 1,
        // 503 for Millmerran 2. Those zeros say "registered", not "ran and
        // generated nothing", so they are emitted as null and read as
        // pre-commission. Only honoured when OpenElectricity knows the date to
        // the day: a 'year' or 'month' specificity would blank real generation
        // at the edges. See the exactly-zero guard in the fill loop — a non-zero
        // reading is never discarded, however early it looks.
        const commissionedOn =
          unit.commencement_date_specificity === 'day' && unit.commencement_date
            ? parseDate(unit.commencement_date.slice(0, 10))
            : null;

        // Fill the full requested range. Branch precedence matters:
        //   1. today/future           → null   (unknown; even a long-retired unit
        //                                        must NOT paint red into the future —
        //                                        the frontier overlay fades this to
        //                                        the page background)
        //   2. a zero before commissioning
        //                             → null   (the DUID existed, the unit did not)
        //   3. a real reading         → CF     (a genuine reading always wins, so
        //                                        generation is never masked by a
        //                                        synthetic 0 if unit_last_seen lags)
        //   4. retired & past its end → 0      (decommissioned: red from last
        //                                        generation up to today)
        //   5. otherwise              → null   (collection gap / not yet commissioned)
        const capacityFactors: (number | null)[] = [];
        let currentDate = requestedStartDate;
        while (currentDate.compare(requestedEndDate) <= 0) {
          const energy = dataByDay.get(currentDate.toString());
          const preCommissioningZero =
            energy === 0 && commissionedOn !== null && currentDate.compare(commissionedOn) < 0;
          if (currentDate.compare(todayBrisbane) >= 0) {
            capacityFactors.push(null);
          } else if (preCommissioningZero) {
            capacityFactors.push(null);
          } else if (energy !== undefined && energy !== null && capacity && capacity > 0) {
            // capacity factor = (energy_MWh / 24h) / registered_capacity * 100.
            // Kept to 3 decimal places: the stripes only need ~integer precision,
            // but downstream consumers reconstruct absolute generation as
            // CF/100 × capacity × 24 (see coal-stats-service), so extra precision
            // here keeps that reconstruction essentially exact.
            const capacityFactor = (energy / 24) / capacity * 100;
            capacityFactors.push(Math.round(capacityFactor * 1000) / 1000);
          } else if (decommissionedAfter && currentDate.compare(decommissionedAfter) > 0) {
            capacityFactors.push(0);
          } else {
            capacityFactors.push(null);
          }
          currentDate = currentDate.add({ days: 1 });
        }

        // Lifecycle dates span every DUID behind the row: a merged station has
        // existed since its oldest member was commissioned, not since the
        // aggregate identifier was registered.
        const commissioned = earliestBy(sources, (u) => u.commencement_date);

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
          // The facilities query asks for 'operating' and 'retired' only, so
          // anything not explicitly retired is operating (the metadata leaves
          // unit_status null for some units).
          status: unit.unit_status === 'retired' ? 'retired' : 'operating',
          commenced: asDate(commissioned?.commencement_date),
          commenced_specificity: commissioned?.commencement_date_specificity ?? null,
          first_seen: asDate(earliestBy(sources, (u) => u.unit_first_seen)?.unit_first_seen),
          last_seen: asDate(latestBy(sources, (u) => u.unit_last_seen)?.unit_last_seen),
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

// The process-wide service singleton, so every route shares one API client (and
// so one rate-limited request queue). Module-level ⇒ per serverless instance.
// It lives here rather than in the capacity-factors route because the purge
// endpoint also needs it, to drop the facilities memo.
let serviceInstance: CapFacDataService | null = null;

export function getCapFacDataService(): CapFacDataService {
  if (!serviceInstance) {
    const apiKey = readEnv('OPENELECTRICITY_API_KEY');
    if (!apiKey) {
      throw new Error('API key not configured');
    }
    serviceInstance = new CapFacDataService(apiKey);
  }
  return serviceInstance;
}
