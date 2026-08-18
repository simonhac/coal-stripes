import { GeneratingUnitCapFacHistoryDTO, GeneratingUnitDTO } from '@/shared/types';
import { FacilityYearTile } from './facility-year-tile';
import { createFacilitiesFromUnits } from './facility-factory';
import { CalendarDate, startOfMonth, endOfMonth } from '@internationalized/date';
import { getDayIndex, getDaysBetween } from '@/shared/date-utils';
import { tileTimingRecorder } from './tile-timing-recorder';

export interface CapFacYear {
  year: number;
  data: GeneratingUnitCapFacHistoryDTO;
  facilityTiles: Map<string, FacilityYearTile>;
  regionCapacityFactors: Map<string, (number | null)[]>; // Map of region name to array of 12 monthly capacity-weighted capacity factors
  // Approximate canvas memory owned by this view alone. The payload `data`
  // above is NOT counted here: it is shared with the other fleet view of the
  // same year, and is measured once, at fetch, on the query that owns it (see
  // yearDataQueryOptions).
  canvasSizeBytes: number;
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
  // Facility codes in each region, in the order they appear in the payload.
  // Precomputed because the region capacity-factor readouts resolve on every
  // day-crossing while a tooltip is showing, and deriving this from `data` there
  // meant walking every unit in the country per region per frame.
  regionFacilityCodes: Map<string, string[]>;
}

/**
 * The region a unit belongs to, as every map in this file keys it: WEM units are
 * their own region, since WEM and the NEM regions are separate data feeds.
 */
export function regionKeyOf(unit: GeneratingUnitDTO): string {
  return unit.network === 'WEM' ? 'WEM' : (unit.region || 'UNKNOWN');
}

/** Facility codes per region, deduped, in payload order. */
function buildRegionFacilityCodes(units: GeneratingUnitDTO[]): Map<string, string[]> {
  const byRegion = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const unit of units) {
    const region = regionKeyOf(unit);
    const key = `${region}|${unit.facility_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const codes = byRegion.get(region);
    if (codes) codes.push(unit.facility_code);
    else byRegion.set(region, [unit.facility_code]);
  }
  return byRegion;
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
    const region = regionKeyOf(unit);
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
 * How many leading days of a tile lie before the record begins, and so should be
 * painted the page background rather than left as the pale blue "no data".
 *
 * TWO boundaries, whichever is later:
 *
 *   • `globalEarliest` — the first day of the whole record (1998-12-07).
 *   • `regionStart` — the first day THIS region has data, which for WEM is
 *     2006-09-20, seven years later. Null when neither loaded year has any data
 *     for the region, in which case the caller's `regionHasDataInWindow` check
 *     is what blanks the row.
 *
 * The region bound is the one that was missing, and its absence was visible: a
 * window reaching back into 2005 showed WEM as page background only while
 * `regionHasDataInWindow` was false. The moment ONE day of WEM data touched the
 * right-hand edge that flag flipped, the whole-row fill stopped, and ~a year of
 * days became pale blue — a hole in the record where there was simply no record
 * yet. Measured on 2005-10-07 → 2006-10-06: 348 of 365 days flipped.
 *
 * Kept here beside `regionHasDataInWindow` because they answer the two halves of
 * one question, and CapFacXAxis derives its month-strip fade the same way — the
 * axis and the stripes above it have to agree on where a region's record starts.
 */
export function leadingBackgroundDays(
  windowStart: CalendarDate,
  globalEarliest: CalendarDate,
  regionStart: CalendarDate | null,
  tileWidth: number,
): number {
  const days = Math.max(
    getDaysBetween(windowStart, globalEarliest),
    regionStart ? getDaysBetween(windowStart, regionStart) : 0,
  );
  return Math.max(0, Math.min(days, tileWidth));
}

/**
 * Build monthly capacity-weighted capacity factors for each region
 */
function buildMonthlyCapacityFactorsForEachRegion(units: GeneratingUnitDTO[], year: number): Map<string, (number | null)[]> {
  const regionCapacityFactors = new Map<string, (number | null)[]>();
  
  // Group units by region
  const unitsByRegion = new Map<string, GeneratingUnitDTO[]>();
  
  for (const unit of units) {
    const region = regionKeyOf(unit);

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
  const regionFacilityCodes = buildRegionFacilityCodes(data.data);

  // Approximate canvas memory (width × height × 4 per tile).
  let canvasSizeBytes = 0;
  for (const tile of facilityTiles.values()) {
    canvasSizeBytes += tile.getSizeBytes();
  }

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
    canvasSizeBytes,
    daysInYear,
    regionFirstDataDayIndex: regionDataBounds.first,
    regionLastDataDayIndex: regionDataBounds.last,
    regionFacilityCodes
  };
}