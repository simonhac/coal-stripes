import { QueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { getDayIndex } from '@/shared/date-utils';
import { yearQueryOptions, isValidYear } from './year-queries';
import { CapFacYear } from './cap-fac-year';

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
 * Read a year synchronously from the query cache, or null if not loaded.
 * Never triggers a fetch — these stats appear once the visible tiles have
 * loaded their data.
 */
function getCachedYear(queryClient: QueryClient, year: number): CapFacYear | null {
  return queryClient.getQueryData(yearQueryOptions(year).queryKey) ?? null;
}

/**
 * Get facility codes for a specific region from cached data
 * Returns null if year data is not cached
 */
export function getFacilityCodesInRegion(
  queryClient: QueryClient,
  regionCode: string,
  year: number
): string[] | null {
  if (!isValidYear(year)) {
    return null;
  }

  const yearData = getCachedYear(queryClient, year);
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
export function calculateFacilityStats(
  queryClient: QueryClient,
  facilityCode: string,
  dateRange: { start: CalendarDate; end: CalendarDate }
): GenerationStats | null {
  const startYear = dateRange.start.year;
  const endYear = dateRange.end.year;

  // Check if years are within bounds
  if (!isValidYear(startYear) || !isValidYear(endYear)) {
    return null;
  }

  let totalWeightedCapacityFactor = 0;
  let totalCapacityDays = 0;

  // Calculate for start year
  const leftYearData = getCachedYear(queryClient, startYear);
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
    const rightYearData = getCachedYear(queryClient, endYear);
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
export function calculateRegionStats(
  queryClient: QueryClient,
  regionCode: string,
  dateRange: { start: CalendarDate; end: CalendarDate }
): GenerationStats | null {
  let totalWeightedCapacityFactor = 0;
  let totalCapacityDays = 0;

  const startYear = dateRange.start.year;

  // Get facilities for this region
  const facilitiesInRegion = getFacilityCodesInRegion(queryClient, regionCode, startYear);

  // If year data not cached, return null
  if (!facilitiesInRegion) {
    return null;
  }

  // Accumulate stats across all facilities in the region
  for (const facilityCode of facilitiesInRegion) {
    const facilityStats = calculateFacilityStats(queryClient, facilityCode, dateRange);
    if (facilityStats === null) {
      console.warn(`Unable to get stats for facility ${facilityCode} in region ${regionCode} - cannot calculate region average`);
      return null;
    }

    totalWeightedCapacityFactor += facilityStats.totalWeightedCapacityFactor;
    totalCapacityDays += facilityStats.totalCapacityDays;
  }

  return { totalWeightedCapacityFactor, totalCapacityDays };
}
