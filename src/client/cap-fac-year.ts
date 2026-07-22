import { GeneratingUnitCapFacHistoryDTO, GeneratingUnitDTO } from '@/shared/types';
import { FacilityYearTile } from './facility-year-tile';
import { createFacilitiesFromUnits } from './facility-factory';
import { CalendarDate, startOfMonth, endOfMonth } from '@internationalized/date';
import { getDayIndex } from '@/shared/date-utils';
import { tileTimingRecorder } from './tile-timing-recorder';

export interface CapFacYear {
  year: number;
  data: GeneratingUnitCapFacHistoryDTO;
  facilityTiles: Map<string, FacilityYearTile>;
  regionCapacityFactors: Map<string, (number | null)[]>; // Map of region name to array of 12 monthly capacity-weighted capacity factors
  totalSizeBytes: number;
  daysInYear: number;
  // Per-region 0-based day-of-year of the FIRST and LAST day any unit in that
  // region has actual (non-null) data; -1 if the region has no data that year.
  // Trailing days after `last` are that region's "no data" frontier; the pair
  // also lets us tell whether a region has any data within a visible window (see
  // regionHasDataInWindow). Keyed the same as regionCapacityFactors (WEM units →
  // 'WEM', else unit.region). Per-region, not global, because WEM and the NEM
  // regions are separate data feeds with different reporting spans.
  regionFirstDataDayIndex: Map<string, number>;
  regionLastDataDayIndex: Map<string, number>;
}

/**
 * Find, per region, the 0-based day index of the first and last day any unit in
 * that region has actual (non-null) data. Both are -1 for a region with no data.
 */
function buildRegionDataDayBounds(units: GeneratingUnitDTO[]): {
  first: Map<string, number>;
  last: Map<string, number>;
} {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (const unit of units) {
    const region = unit.network === 'WEM' ? 'WEM' : (unit.region || 'UNKNOWN');
    const data = unit.history.data;
    let unitFirst = -1;
    let unitLast = -1;
    if (data) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== null) { unitFirst = i; break; }
      }
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== null) { unitLast = i; break; }
      }
    }
    if (unitFirst >= 0) {
      const pf = first.get(region);
      if (pf === undefined || pf < 0 || unitFirst < pf) first.set(region, unitFirst);
    } else if (!first.has(region)) {
      first.set(region, -1);
    }
    const pl = last.get(region);
    if (pl === undefined || unitLast > pl) last.set(region, unitLast);
  }
  return { first, last };
}

/**
 * Whether a region has any actual data within the visible day window. The
 * window spans [startDayIdx, end-of-startYear] in the start year and
 * [0, endDayIdx] in the end year (a single year when they coincide). Used to
 * fade a region that has no data at all across the view to the page background,
 * rather than the pale-blue "no data" colour reserved for interior gaps.
 */
export function regionHasDataInWindow(
  startData: CapFacYear | undefined,
  endData: CapFacYear | undefined,
  regionCode: string,
  startDayIdx: number,
  endDayIdx: number,
  sameYear: boolean,
): boolean {
  if (sameYear) {
    if (!startData) return false;
    const first = startData.regionFirstDataDayIndex.get(regionCode) ?? -1;
    const last = startData.regionLastDataDayIndex.get(regionCode) ?? -1;
    return last >= 0 && last >= startDayIdx && first <= endDayIdx;
  }
  // Start year: data lands in the visible tail if its last data day reaches it.
  if (startData) {
    const last = startData.regionLastDataDayIndex.get(regionCode) ?? -1;
    if (last >= 0 && last >= startDayIdx) return true;
  }
  // End year: data lands in the visible head if its first data day is within it.
  if (endData) {
    const first = endData.regionFirstDataDayIndex.get(regionCode) ?? -1;
    if (first >= 0 && first <= endDayIdx) return true;
  }
  return false;
}

/**
 * Build monthly capacity-weighted capacity factors for each region
 */
function buildMonthlyCapacityFactorsForEachRegion(units: GeneratingUnitDTO[], year: number): Map<string, (number | null)[]> {
  const regionCapacityFactors = new Map<string, (number | null)[]>();
  
  // Group units by region
  const unitsByRegion = new Map<string, GeneratingUnitDTO[]>();
  
  for (const unit of units) {
    // For WA network (WEM), use "WEM" as the region
    const region = unit.network === 'WEM' ? 'WEM' : (unit.region || 'UNKNOWN');
    
    if (!unitsByRegion.has(region)) {
      unitsByRegion.set(region, []);
    }
    unitsByRegion.get(region)!.push(unit);
  }
  
  // Calculate capacity-weighted capacity factors for each region
  for (const [region, regionUnits] of unitsByRegion) {
    const monthlyFactors: (number | null)[] = new Array(12);
    
    // For each month (0-11)
    for (let month = 0; month < 12; month++) {
      let totalCapacityFactorWeighted = 0;
      let totalCapacity = 0;
      let hasData = false;
      
      // Calculate capacity-weighted average for this month
      for (const unit of regionUnits) {
        // Get the first and last day of the month
        const monthDate = new CalendarDate(year, month + 1, 1);
        const monthStart = startOfMonth(monthDate);
        const monthEnd = endOfMonth(monthDate);
        
        // Get day indices for the month boundaries
        const startDayIndex = getDayIndex(monthStart);
        const endDayIndex = getDayIndex(monthEnd);
        
        // Calculate monthly average from daily data
        let monthTotal = 0;
        let monthDays = 0;
        let monthHasData = false;
        
        for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex++) {
          if (unit.history.data && dayIndex < unit.history.data.length) {
            const dailyCapacityFactor = unit.history.data[dayIndex];
            if (dailyCapacityFactor !== null) {
              monthTotal += dailyCapacityFactor;
              monthDays++;
              monthHasData = true;
            }
          }
        }
        
        // Only include this unit if it has data for this month
        if (monthHasData && monthDays > 0) {
          const monthlyAverage = monthTotal / monthDays;
          totalCapacityFactorWeighted += monthlyAverage * unit.capacity;
          totalCapacity += unit.capacity;
          hasData = true;
        }
      }
      
      // Calculate weighted average or null if no data
      monthlyFactors[month] = hasData && totalCapacity > 0 
        ? totalCapacityFactorWeighted / totalCapacity 
        : null;
    }
    
    regionCapacityFactors.set(region, monthlyFactors);
  }
  
  return regionCapacityFactors;
}

/**
 * Groups units by facility code and creates FacilityYearTile objects
 */
export function createCapFacYear(
  year: number,
  data: GeneratingUnitCapFacHistoryDTO
): CapFacYear {
  // Time the whole build (all tiles + monthly roll-ups) as `year-build`, and
  // each facility's canvas paint as `tile-build` — see tile-timing-recorder.
  const yearBuildStart = performance.now();

  const facilityTiles = new Map<string, FacilityYearTile>();

  // Create Facility objects from units
  const facilities = createFacilitiesFromUnits(data.data);

  // Create a FacilityYearTile for each facility (the constructor paints its
  // canvas synchronously, so timing the construction captures the full paint).
  for (const [facilityCode, facility] of facilities) {
    const tile = tileTimingRecorder.time(
      'tile-build',
      { year, facility: facilityCode },
      () => new FacilityYearTile(facility, year),
    );
    facilityTiles.set(facilityCode, tile);
  }
  
  // Build monthly capacity-weighted capacity factors for each region
  const regionCapacityFactors = buildMonthlyCapacityFactorsForEachRegion(data.data, year);
  const regionDataBounds = buildRegionDataDayBounds(data.data);
  
  // Calculate total size: JSON data + canvas memory
  const jsonSizeBytes = JSON.stringify(data).length;
  let canvasSizeBytes = 0;
  
  // Calculate canvas memory
  for (const tile of facilityTiles.values()) {
    canvasSizeBytes += tile.getSizeBytes();
  }
  
  const totalSizeBytes = jsonSizeBytes + canvasSizeBytes;
  
  // Determine days in year from the data
  const daysInYear = data.data.length > 0 && data.data[0].history.data 
    ? data.data[0].history.data.length 
    : 365;
  
  tileTimingRecorder.record({
    kind: 'year-build',
    year,
    ms: performance.now() - yearBuildStart,
    at: Date.now(),
  });

  return {
    year,
    data,
    facilityTiles,
    regionCapacityFactors,
    totalSizeBytes,
    daysInYear,
    regionFirstDataDayIndex: regionDataBounds.first,
    regionLastDataDayIndex: regionDataBounds.last
  };
}