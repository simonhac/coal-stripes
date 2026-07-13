import { CalendarDate } from '@internationalized/date';
import { getTodayAEST, getDaysBetween } from '@/shared/date-utils';
import { DATE_BOUNDARIES } from '@/shared/config';

/**
 * Centralised date boundary calculations for the application
 * All date boundary logic should use this module to ensure consistency
 */

/**
 * Get the date boundaries for the application
 * @returns Object with all relevant date boundaries
 */
export function getDateBoundaries() {
  // Data boundaries
  const earliestDataDay = DATE_BOUNDARIES.EARLIEST_START_DATE;
  const earliestDataEndDay = earliestDataDay.add({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }); // First valid end date for full year
  const latestDataDay = getTodayAEST().subtract({ days: 1 }); // Yesterday AEST
  
  // Display boundaries (with slop buffer)
  const slopMonths = DATE_BOUNDARIES.DISPLAY_SLOP_MONTHS;
  const earliestDisplayDay = earliestDataDay.subtract({ months: slopMonths });
  const latestDisplayDay = latestDataDay.add({ months: slopMonths });
  // For end date navigation, the earliest we can display is based on earliestDataEndDay
  const earliestDisplayEndDay = earliestDataEndDay.subtract({ months: slopMonths });
  
  // Year boundaries
  const earliestDataYear = earliestDataDay.year;
  const latestDataYear = latestDataDay.year;
  
  return {
    // Data boundaries (hard limits for actual data)
    earliestDataDay,
    earliestDataEndDay, // Use this for end date navigation boundaries
    latestDataDay,
    earliestDataYear,
    latestDataYear,
    
    // Display boundaries (soft limits with buffer for UI)
    earliestDisplayDay,
    earliestDisplayEndDay,
    latestDisplayDay,
    
    // Utility methods
    isWithinDataBounds(date: CalendarDate): boolean {
      return date.compare(earliestDataDay) >= 0 && date.compare(latestDataDay) <= 0;
    },
    
    isWithinDisplayBounds(date: CalendarDate): boolean {
      return date.compare(earliestDisplayDay) >= 0 && date.compare(latestDisplayDay) <= 0;
    },
    
    isEndDateWithinDisplayBounds(endDate: CalendarDate): boolean {
      return endDate.compare(earliestDisplayEndDay) >= 0 && endDate.compare(latestDisplayDay) <= 0;
    },
    
    clampToDataBounds(date: CalendarDate): CalendarDate {
      if (date.compare(earliestDataDay) < 0) return earliestDataDay;
      if (date.compare(latestDataDay) > 0) return latestDataDay;
      return date;
    },
    
    clampToDisplayBounds(date: CalendarDate): CalendarDate {
      if (date.compare(earliestDisplayDay) < 0) return earliestDisplayDay;
      if (date.compare(latestDisplayDay) > 0) return latestDisplayDay;
      return date;
    },
    
    clampEndDateToDisplayBounds(endDate: CalendarDate): CalendarDate {
      if (endDate.compare(earliestDisplayEndDay) < 0) return earliestDisplayEndDay;
      if (endDate.compare(latestDisplayDay) > 0) return latestDisplayDay;
      return endDate;
    },
    
    /**
     * Calculate overstep based on offset from earliestDataEndDay
     * @param offset Days since earliestDataEndDay (offset 0 = first valid end date)
     * @returns Overstep amount (positive when outside valid data bounds), null when within bounds
     */
    calculateOverstep(offset: number): number | null {
      // Offset 0 = earliestDataEndDay (first valid end date for full year)
      // Negative offset = before first valid end date
      // Positive offset = days after first valid end date
      
      // Calculate the maximum valid offset (days from earliestDataEndDay to latestDataDay)
      const maxValidOffset = getDaysBetween(earliestDataEndDay, latestDataDay);
      
      if (offset < 0) {
        // We're before the first valid end date
        return -offset;
      } else if (offset > maxValidOffset) {
        // We're after the latest valid data
        return offset - maxValidOffset;
      }
      
      // We're within valid bounds
      return null;
    }
  };
}

// Export a type for the return value
export type DateBoundaries = ReturnType<typeof getDateBoundaries>;