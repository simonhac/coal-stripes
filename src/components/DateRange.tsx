import React from 'react';
import { CalendarDate } from '@internationalized/date';
import { getMonthName } from '@/shared/date-utils';

interface DateRangeProps {
  dateRange: { start: CalendarDate; end: CalendarDate } | null;
}

export function formatDateRange(dateRange: { start: CalendarDate; end: CalendarDate }): string {
  const format = (date: CalendarDate) => `${date.day} ${getMonthName(date)} ${date.year}`;
  return `${format(dateRange.start)} – ${format(dateRange.end)}`;
}

export function DateRange({ dateRange }: DateRangeProps) {
  // Before the timeline has been positioned — the first frames of any load —
  // hold the row's height without announcing anything. This readout sits in the
  // page head, above the stripes, so a flash of "Loading..." here is precisely
  // the jolt the rest of the shell is arranged to avoid.
  if (!dateRange) return <div className="opennem-date-range">&nbsp;</div>;

  return (
    <div className="opennem-date-range">
      {formatDateRange(dateRange)}
    </div>
  );
}

/**
 * The same readout, borrowed by the pinned region header once the page-head one
 * has scrolled behind the top bar. A distinct class, not just a smaller
 * `.opennem-date-range`: only one of the two is ever on screen, and keeping the
 * page-head selector unique is what lets tests locate it unambiguously.
 */
export function RegionHeaderDateRange({ dateRange }: DateRangeProps) {
  if (!dateRange) return null;

  return (
    <div className="opennem-region-date-range">
      {formatDateRange(dateRange)}
    </div>
  );
}
