import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { LRUCache, CacheStats } from '@/shared/lru-cache';
import { CapFacYear, createCapFacYear } from './cap-fac-year';
import { RequestQueue, RequestQueueConfig, QueueStats } from '@/shared/request-queue';
import { NoOpRequestQueueLogger } from '@/shared/request-queue-logger';
import { CalendarDate } from '@internationalized/date';
import { getDayIndex } from '@/shared/date-utils';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { CLIENT_REQUEST_QUEUE_CONFIG, CACHE_CONFIG } from '@/shared/config';

export interface GenerationStats {
  totalWeightedCapacityFactor: number;
  totalCapacityDays: number;
}

/**
 * Calculate average capacity factor from generation statistics
 * Returns null if stats are null or totalCapacityDays is 0
 */
export function calculateAverageCapacityFactor(stats: GenerationStats | null): number | null {
  if (stats === null || stats.totalCapacityDays === 0) {
    return null;
  }
  return stats.totalWeightedCapacityFactor / stats.totalCapacityDays;
}

/**
 * Get region names (long and short) for a given region code
 */
export function getRegionNames(regionCode: string): { long: string; short: string } {
  const regionNames: Record<string, { long: string; short: string }> = {
    'NSW1': { long: 'New South Wales', short: 'NSW' },
    'QLD1': { long: 'Queensland', short: 'QLD' },
    'SA1': { long: 'South Australia', short: 'SA' },
    'TAS1': { long: 'Tasmania', short: 'TAS' },
    'VIC1': { long: 'Victoria', short: 'VIC' },
    'WEM': { long: 'Western Australia', short: 'WA' }
  };
  
  return regionNames[regionCode] || { long: regionCode, short: regionCode };
}

/**
 * The client's single source of capacity-factor data, one calendar year at a
 * time. Note the separation of concerns: the browser NEVER talks to
 * OpenElectricity directly — this vendor fetches from our own
 * /api/capacity-factors route (which holds the API key and does the heavy
 * lifting), then pre-renders each year into canvas tiles (CapFacYear).
 *
 * Years are cached in an LRU; fetches run through a RequestQueue for retry,
 * rate limiting, and dedup; adjacent years are prefetched in the background
 * so scrolling the timeline rarely waits on the network.
 */
export class YearDataVendor {
  private cache: LRUCache<CapFacYear>;
  private requestQueue: RequestQueue<CapFacYear>;

  /**
   * Get the earliest year for which data is available
   */
  static getEarliestYear(): number {
    return getDateBoundaries().earliestDataYear;
  }

  /**
   * Get the latest year for which data might be available
   * This is the current year since data is collected in real-time
   */
  static getLatestYear(): number {
    return getDateBoundaries().latestDataYear;
  }

  /**
   * Check if a year is within valid bounds
   */
  static isValidYear(year: number): boolean {
    return year >= YearDataVendor.getEarliestYear() && year <= YearDataVendor.getLatestYear();
  }

  constructor(maxYears: number = 30, queueConfig?: Partial<RequestQueueConfig>) {
    this.cache = new LRUCache<CapFacYear>(maxYears);
    this.requestQueue = new RequestQueue<CapFacYear>(
      { ...CLIENT_REQUEST_QUEUE_CONFIG, ...queueConfig }, // Allow overriding for tests
      new NoOpRequestQueueLogger()
    );
  }

  /**
   * Get data for a year synchronously if it's in the cache
   * @param year The year to get
   * @returns The data if cached, null otherwise
   * @throws Error if year is outside valid bounds
   */
  getYearSync(year: number): CapFacYear | null {
    // Validate year bounds
    if (!YearDataVendor.isValidYear(year)) {
      const earliest = YearDataVendor.getEarliestYear();
      const latest = YearDataVendor.getLatestYear();
      throw new Error(`Year ${year} is outside valid bounds. Data is available from ${earliest} to ${latest}.`);
    }

    const result = this.cache.get(year.toString());
    return result || null;
  }

  /**
   * Request data for a specific year
   * @returns Promise that resolves with the data (immediately if cached)
   * @throws Error if year is outside valid bounds
   */
  async requestYear(year: number): Promise<CapFacYear> {
    // Validate year bounds
    if (!YearDataVendor.isValidYear(year)) {
      const earliest = YearDataVendor.getEarliestYear();
      const latest = YearDataVendor.getLatestYear();
      throw new Error(`Year ${year} is outside valid bounds. Data is available from ${earliest} to ${latest}.`);
    }

    // Check cache first
    const cached = this.cache.get(year.toString());
    if (cached) {
      // Prefetch adjacent years in background
      this.prefetchAdjacentYears(year);
      return Promise.resolve(cached);
    }

    // Use RequestQueue to handle fetching with retry and rate limiting
    const result = this.requestQueue.add({
      execute: () => this.fetchYear(year),
      priority: 1, // Normal priority
      method: 'GET',
      url: `/api/capacity-factors?year=${year}`,
      label: year.toString(),
      onError: (error) => {
        console.error(`Failed to fetch year ${year}:`, error);
      }
    }, { addToFront: true }); // Client requests go to front of queue
    
    // Prefetch adjacent years after this year loads successfully
    result.then(() => {
      this.prefetchAdjacentYears(year);
    }).catch(() => {
      // Ignore prefetch errors
    });
    
    return result;
  }
  
  /**
   * Prefetch adjacent years in the background (low priority)
   */
  private prefetchAdjacentYears(currentYear: number): void {
    // Preload 2 years before and after
    this.preloadYear(currentYear - 2);
    this.preloadYear(currentYear - 1);
    this.preloadYear(currentYear + 1);
    this.preloadYear(currentYear + 2);
  }

  /**
   * Preload a specific year if it's not already cached or in progress
   */
  private preloadYear(year: number): void {
    // Check if year is valid
    if (!YearDataVendor.isValidYear(year)) {
      return;
    }

    // Check if already cached
    if (this.cache.has(year.toString())) {
      return;
    }

    // Check if already in queue
    const url = `/api/capacity-factors?year=${year}`;
    if (this.requestQueue.hasRequestForUrl(url)) {
      return;
    }

    // Add to queue with low priority; prefetch failures are ignored — the
    // year will be fetched properly (with error reporting) when needed.
    this.requestQueue.add({
      execute: () => this.fetchYear(year),
      priority: 0, // Low priority for prefetch
      method: 'GET',
      url: `/api/capacity-factors?year=${year}`,
      label: year.toString()
    }, { addToFront: false }).catch(() => {
      // Ignore prefetch failures
    });
  }

  /**
   * Check if a year is currently cached
   */
  hasYear(year: number): boolean {
    return this.cache.has(year.toString());
  }

  /**
   * Get cache statistics including pending fetches
   */
  getCacheStats(): CacheStats & QueueStats {
    const cacheStats = this.cache.getStats();
    const queueStats = this.requestQueue.getStats();
    
    return {
      ...cacheStats,
      ...queueStats
    };
  }

  /**
   * Clear all cached data and cancel pending fetches
   */
  clear(): void {
    this.cache.clear();
    this.requestQueue.clear();
  }

  /**
   * Fetch year data from server and create tiles
   */
  private async fetchYear(year: number): Promise<CapFacYear> {
    const response = await fetch(`/api/capacity-factors?year=${year}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: GeneratingUnitCapFacHistoryDTO = await response.json();

    // Create CapFacYear with pre-rendered tiles
    const capFacYear = createCapFacYear(year, data);

    // Cache the result with the total size (JSON + canvas memory)
    this.cache.set(year.toString(), capFacYear, capFacYear.totalSizeBytes, year.toString());

    return capFacYear;
  }

  /**
   * Clear all cached data - useful when feature flags change
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get facility codes for a specific region from cached data
   * Returns null if year data is not cached
   */
  getFacilityCodesInRegion(regionCode: string, year: number): string[] | null {
    const yearData = this.getYearSync(year);
    if (!yearData) {
      return null;
    }
    
    const facilityCodesInRegion: string[] = [];
    
    // Check each unit in the raw data to find facilities in this region
    for (const unit of yearData.data.data) {
      const unitRegion = unit.network === 'WEM' ? 'WEM' : (unit.region || 'UNKNOWN');
      if (unitRegion === regionCode && !facilityCodesInRegion.includes(unit.facility_code)) {
        facilityCodesInRegion.push(unit.facility_code);
      }
    }
    
    return facilityCodesInRegion;
  }

  /**
   * Calculate generation statistics for a facility across a date range
   * Returns null if data is not available in cache
   */
  calculateFacilityStats(regionCode: string, facilityCode: string, dateRange: { start: CalendarDate; end: CalendarDate }): GenerationStats | null {
    const startYear = dateRange.start.year;
    const endYear = dateRange.end.year;
    
    // Check if years are within bounds
    if (!YearDataVendor.isValidYear(startYear) || !YearDataVendor.isValidYear(endYear)) {
      return null;
    }
    
    let totalWeightedCapacityFactor = 0;
    let totalCapacityDays = 0;
    
    // Calculate for start year
    const leftYearData = this.getYearSync(startYear);
    if (!leftYearData) return null;
    
    const leftTile = leftYearData.facilityTiles.get(facilityCode);
    if (!leftTile) return null;
    
    const leftStartDay = getDayIndex(dateRange.start);
    const leftEndDay = startYear === endYear 
      ? getDayIndex(dateRange.end) 
      : leftYearData.daysInYear - 1;
    
    for (const unit of leftTile.getUnits()) {
      for (let day = leftStartDay; day <= leftEndDay; day++) {
        const cf = unit.history.data[day];
        if (cf !== null) {
          totalWeightedCapacityFactor += cf * unit.capacity;
          totalCapacityDays += unit.capacity;
        }
      }
    }
    
    // Calculate for end year if different
    if (startYear !== endYear) {
      const rightYearData = this.getYearSync(endYear);
      if (!rightYearData) return null;
      
      const rightTile = rightYearData.facilityTiles.get(facilityCode);
      if (!rightTile) return null;
      
      const rightEndDay = getDayIndex(dateRange.end);
      
      for (const unit of rightTile.getUnits()) {
        for (let day = 0; day <= rightEndDay; day++) {
          const cf = unit.history.data[day];
          if (cf !== null) {
            totalWeightedCapacityFactor += cf * unit.capacity;
            totalCapacityDays += unit.capacity;
          }
        }
      }
    }
    
    return { totalWeightedCapacityFactor, totalCapacityDays };
  }

  /**
   * Calculate generation statistics for a region across a date range
   * Returns null if data is not available in cache
   */
  calculateRegionStats(regionCode: string, dateRange: { start: CalendarDate; end: CalendarDate }): GenerationStats | null {
    let totalWeightedCapacityFactor = 0;
    let totalCapacityDays = 0;
    
    const startYear = dateRange.start.year;
    
    // Get facilities for this region
    const facilitiesInRegion = this.getFacilityCodesInRegion(regionCode, startYear);
    
    // If year data not cached, return null
    if (!facilitiesInRegion) {
      return null;
    }
    
    // Accumulate stats across all facilities in the region
    for (const facilityCode of facilitiesInRegion) {
      const facilityStats = this.calculateFacilityStats(regionCode, facilityCode, dateRange);
      if (facilityStats === null) {
        console.warn(`Unable to get stats for facility ${facilityCode} in region ${regionCode} - cannot calculate region average`);
        return null;
      }
      
      totalWeightedCapacityFactor += facilityStats.totalWeightedCapacityFactor;
      totalCapacityDays += facilityStats.totalCapacityDays;
    }
    
    return { totalWeightedCapacityFactor, totalCapacityDays };
  }
}

// Export singleton instance
export const yearDataVendor = new YearDataVendor(CACHE_CONFIG.CLIENT_MAX_YEARS);