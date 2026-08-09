import { QueryClient } from '@tanstack/react-query';
import { CalendarDate, parseDate } from '@internationalized/date';
import { getDayIndex } from '@/shared/date-utils';
import { yearQueryOptions, isValidYear } from './year-queries';
import { CapFacYear } from './cap-fac-year';
import { formatUnitName } from './unit-names';
import { FleetMode } from '@/shared/types';

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
function getCachedYear(queryClient: QueryClient, mode: FleetMode, year: number): CapFacYear | null {
  return queryClient.getQueryData(yearQueryOptions(queryClient, mode, year).queryKey) ?? null;
}

/**
 * Get facility codes for a specific region from cached data
 * Returns null if year data is not cached
 */
export function getFacilityCodesInRegion(
  queryClient: QueryClient,
  mode: FleetMode,
  regionCode: string,
  year: number
): string[] | null {
  if (!isValidYear(year)) {
    return null;
  }

  const yearData = getCachedYear(queryClient, mode, year);
  if (!yearData) {
    return null;
  }

  return yearData.regionFacilityCodes.get(regionCode) ?? [];
}

/**
 * A region's capacity-weighted average for one calendar month, from the
 * roll-up computed once per year at tile-build time. O(1), and — unlike
 * averaging the daily values ourselves — it is the same number the month bar
 * on the axis is coloured with.
 *
 * Returns null when the year isn't cached or the region has no data that month.
 */
export function getRegionMonthCapacityFactor(
  queryClient: QueryClient,
  mode: FleetMode,
  regionCode: string,
  monthStart: CalendarDate
): number | null {
  if (!isValidYear(monthStart.year)) {
    return null;
  }

  const yearData = getCachedYear(queryClient, mode, monthStart.year);
  return yearData?.regionCapacityFactors.get(regionCode)?.[monthStart.month - 1] ?? null;
}

/**
 * Calculate generation statistics for a facility across a date range
 * Returns null if data is not available in cache
 */
export function calculateFacilityStats(
  queryClient: QueryClient,
  mode: FleetMode,
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
  const leftYearData = getCachedYear(queryClient, mode, startYear);
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
    const rightYearData = getCachedYear(queryClient, mode, endYear);
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

/** One unit's lifecycle, as the facility hovercard lists it. */
export interface FacilityUnitLifecycle {
  /** Display name — the DUID, shortened for WEM. */
  name: string;
  /** Registered capacity, MW. */
  capacity: number;
  /** Year the unit was commissioned, or null when OpenElectricity doesn't say. */
  commencedYear: number | null;
  /** Year it last generated; null while it is still operating. */
  retiredYear: number | null;
}

/** A facility's units and their combined registered capacity. */
export interface FacilityLifecycle {
  /** Registered capacity of every unit below, MW. */
  totalCapacity: number;
  units: FacilityUnitLifecycle[];
}

/**
 * The calendar year of a lifecycle date.
 *
 * OpenElectricity stores a date it only knows to the year as 31 December of
 * that year (`commenced_specificity: 'year'` ⇒ '1981-12-31'), so the year is
 * usable whatever the specificity — there is nothing to correct for.
 */
function lifecycleYear(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  try {
    return parseDate(stamp.slice(0, 10)).year;
  } catch {
    return null;
  }
}

/**
 * A facility's units — capacity, and when each was commissioned (and retired) —
 * read from whichever displayed year is already cached.
 *
 * Never triggers a fetch — like the capacity-factor readouts, this appears once
 * the visible tiles have their data. The order is the tile's own unit order, so
 * the list reads top-to-bottom against the stripes it describes.
 */
export function getFacilityLifecycle(
  queryClient: QueryClient,
  mode: FleetMode,
  facilityCode: string,
  dateRange: { start: CalendarDate; end: CalendarDate }
): FacilityLifecycle | null {
  const years = dateRange.start.year === dateRange.end.year
    ? [dateRange.start.year]
    : [dateRange.start.year, dateRange.end.year];

  for (const year of years) {
    if (!isValidYear(year)) continue;

    const yearData = getCachedYear(queryClient, mode, year);
    const tile = yearData?.facilityTiles.get(facilityCode);
    if (!tile) continue;

    const network = tile.getNetwork();
    return {
      totalCapacity: tile.getTotalCapacity(),
      units: tile.getUnits().map(unit => ({
        name: formatUnitName(unit.unitName, network),
        capacity: unit.capacity,
        commencedYear: lifecycleYear(unit.commenced),
        retiredYear: unit.status === 'retired' ? lifecycleYear(unit.lastSeen) : null
      }))
    };
  }

  return null;
}

/**
 * Calculate generation statistics for a region across a date range
 * Returns null if data is not available in cache
 */
export function calculateRegionStats(
  queryClient: QueryClient,
  mode: FleetMode,
  regionCode: string,
  dateRange: { start: CalendarDate; end: CalendarDate }
): GenerationStats | null {
  let totalWeightedCapacityFactor = 0;
  let totalCapacityDays = 0;

  const startYear = dateRange.start.year;

  // Get facilities for this region
  const facilitiesInRegion = getFacilityCodesInRegion(queryClient, mode, regionCode, startYear);

  // If year data not cached, return null
  if (!facilitiesInRegion) {
    return null;
  }

  // Accumulate stats across all facilities in the region
  for (const facilityCode of facilitiesInRegion) {
    // A facility whose year isn't cached makes the region average unanswerable.
    // Deliberately silent: the readouts re-resolve on every day-crossing while a
    // tooltip is showing, so a cold year would log this once per region per frame.
    const facilityStats = calculateFacilityStats(queryClient, mode, facilityCode, dateRange);
    if (facilityStats === null) {
      return null;
    }

    totalWeightedCapacityFactor += facilityStats.totalWeightedCapacityFactor;
    totalCapacityDays += facilityStats.totalCapacityDays;
  }

  return { totalWeightedCapacityFactor, totalCapacityDays };
}
