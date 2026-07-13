import { OEClientQueued } from './queued-oeclient';
import {
  GeneratingUnitCapFacHistoryDTO,
  GeneratingUnitDTO
} from '@/shared/types';
import { CalendarDate, parseDate } from '@internationalized/date';
import { getAESTDateTimeString, networkDayFromInterval, getTodayAEST } from '@/shared/date-utils';
import { LRUCache } from '@/shared/lru-cache';
import { CACHE_CONFIG } from '@/shared/config';
import type { NetworkCode } from 'openelectricity';

// A single coal generating unit as returned by the facilities endpoint.
interface UnitRecord {
  facility_code: string;
  facility_name: string;
  facility_network: string;
  facility_region: string;
  unit_code: string;
  unit_fueltech: string;
  unit_capacity: number;
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

export class CapFacDataService {
  private client: OEClientQueued;
  private facilitiesCache: Facility[] | null = null;
  private facilitiesFetchPromise: Promise<Facility[]> | null = null;
  private yearDataCache: LRUCache<string>;

  constructor(apiKey: string) {
    this.client = new OEClientQueued(apiKey);
    this.yearDataCache = new LRUCache<string>(CACHE_CONFIG.SERVER_MAX_YEARS);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Wait for any pending facility fetch to complete
    if (this.facilitiesFetchPromise) {
      try {
        await this.facilitiesFetchPromise;
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Clear caches and any pending requests
    this.facilitiesCache = null;
    this.facilitiesFetchPromise = null;
    this.yearDataCache.clear();
    this.client.clearQueue();
  }

  /**
   * Fetch capacity factors for coal units for a specific year.
   * Always returns data for the full year with today and future dates nulled out.
   */
  async getCapacityFactors(year: number): Promise<GeneratingUnitCapFacHistoryDTO> {
    const cacheKey = year.toString();

    // Check cache first
    const cachedJson = this.yearDataCache.get(cacheKey);
    if (cachedJson) {
      debug(`📦 Cache hit: ${year}`);
      return JSON.parse(cachedJson);
    }

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

    // Convert to JSON and cache
    const jsonString = JSON.stringify(coalStripesData);
    const sizeInBytes = jsonString.length;

    // The current year gains a new day daily, so it expires after an hour.
    // Past years are historical/immutable — keep them for the life of the warm
    // instance (the LRU's SERVER_MAX_YEARS bound handles eviction).
    const currentYear = getTodayAEST().year;
    const expiresAt =
      year === currentYear
        ? new Date(Date.now() + CACHE_CONFIG.CURRENT_YEAR_REVALIDATE_SECONDS * 1000)
        : undefined;

    this.yearDataCache.set(cacheKey, jsonString, sizeInBytes, `Year ${year}`, expiresAt);

    const elapsed = Math.round(performance.now() - startTime);
    const expiryInfo = year === currentYear ? ' (expires in 1 hour)' : ' (kept until evicted)';
    debug(
      `✅ API response: ${year} | ${elapsed}ms | Cached (${Math.round(sizeInBytes / 1024)}KB)${expiryInfo}`
    );

    return coalStripesData;
  }

  /**
   * Get queue statistics for monitoring
   */
  public getQueueStats() {
    return this.client.getQueueStats();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return this.yearDataCache.getStats();
  }

  /**
   * Get all coal facilities from OpenElectricity API
   */
  private async getAllCoalFacilities(): Promise<Facility[]> {
    // Return cached facilities if available
    if (this.facilitiesCache) {
      return this.facilitiesCache;
    }

    // Return existing promise if fetch is in progress
    if (this.facilitiesFetchPromise) {
      return this.facilitiesFetchPromise;
    }

    // Start new fetch
    this.facilitiesFetchPromise = (async () => {
      try {
        debug('🏭 Fetching coal facilities...');
        const { table } = await this.client.getFacilities({
          status_id: ['operating'],
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

        this.facilitiesCache = facilities;
        debug(`🏭 Found ${facilities.length} coal facilities with ${units.length} units`);

        return facilities;
      } finally {
        this.facilitiesFetchPromise = null;
      }
    })();

    return this.facilitiesFetchPromise;
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
        return this.client
          .getFacilityData(network as NetworkCode, facilityCodes, ['energy'], {
            interval: '1d',
            dateStart: startDate,
            dateEnd
          })
          .catch((err: unknown) => {
            debug(`   Failed to fetch ${network} data:`, err);
            throw err;
          });
      })
    );

    const rows: EnergyRow[] = [];
    for (const response of responses) {
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

      for (const unit of sortedUnits) {
        const unitData = data.filter((row) => row.unit_code === unit.unit_code);
        if (unitData.length === 0) {
          continue; // Skip units with no data
        }

        // Map each reading to its network-local calendar day for quick lookup.
        const dataByDay = new Map<string, EnergyRow>(
          unitData.map((row) => [
            networkDayFromInterval(row.interval, facility.facility_network).toString(),
            row
          ])
        );

        // Fill the full requested range; missing/today/future days are null.
        const capacityFactors: (number | null)[] = [];
        let currentDate = requestedStartDate;
        while (currentDate.compare(requestedEndDate) <= 0) {
          const dayData = dataByDay.get(currentDate.toString());
          if (currentDate.compare(todayBrisbane) >= 0) {
            capacityFactors.push(null);
          } else if (dayData && dayData.energy !== null) {
            // capacity factor = (energy_MWh / 24h) / registered_capacity * 100
            const capacityFactor = (dayData.energy / 24) / unit.unit_capacity * 100;
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
          capacity: unit.unit_capacity,
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
