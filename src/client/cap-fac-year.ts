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
    daysInYear
  };
}