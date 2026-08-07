import { useCallback } from 'react';
import { CalendarDate } from '@internationalized/date';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { DATE_BOUNDARIES } from '@/shared/config';

// Clamp an end date to the valid data range [earliestDataEndDay, latestDataDay].
function clampEndDate(endDate: CalendarDate): CalendarDate {
  const boundaries = getDateBoundaries();
  if (endDate.compare(boundaries.latestDataDay) > 0) return boundaries.latestDataDay;
  if (endDate.compare(boundaries.earliestDataEndDay) < 0) return boundaries.earliestDataEndDay;
  return endDate;
}

interface UseKeyboardNavigationOptions {
  currentEndDate: CalendarDate | null;
  /** Animate to an absolute end date (drives the shared gesture spring). */
  navigateToDate: (date: CalendarDate) => void;
}

/**
 * The timeline's navigation actions.
 *
 * Knows nothing about keys — the bindings live in src/shared/shortcuts.ts and
 * are dispatched by useShortcuts. Every action delegates its animation to the
 * shared gesture spring via `navigateToDate`, so keyboard, month-clicks, drag
 * and wheel all move through one animator.
 */
export function useKeyboardNavigation({
  currentEndDate,
  navigateToDate,
}: UseKeyboardNavigationOptions) {
  // Navigate by months
  const navigateByMonths = useCallback((months: number) => {
    if (!currentEndDate) return;
    navigateToDate(clampEndDate(currentEndDate.add({ months })));
  }, [currentEndDate, navigateToDate]);

  // Navigate so the given month is the first month displayed
  const navigateToMonth = useCallback((year: number, month: number) => {
    const firstOfMonth = new CalendarDate(year, month, 1);
    navigateToDate(clampEndDate(firstOfMonth.add({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 })));
  }, [navigateToDate]);

  // Navigate to the most recent data (yesterday — today's data is incomplete)
  const navigateToToday = useCallback(() => {
    const boundaries = getDateBoundaries();
    navigateToDate(boundaries.latestDataDay);
  }, [navigateToDate]);

  // Navigate so January 1 of the given year is the first day displayed
  const navigateToYearStart = useCallback((targetYear: number) => {
    const jan1 = new CalendarDate(targetYear, 1, 1);
    navigateToDate(clampEndDate(jan1.add({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 })));
  }, [navigateToDate]);

  // Navigate to start (earliest data end day)
  const navigateToStart = useCallback(() => {
    const boundaries = getDateBoundaries();
    navigateToDate(boundaries.earliestDataEndDay);
  }, [navigateToDate]);

  // Snap to the previous (dir < 0) or next (dir > 0) year boundary. When the
  // view already starts on Jan 1, step a whole year rather than sitting still.
  const navigateToYearBoundary = useCallback((dir: number) => {
    if (!currentEndDate) return;
    const startDate = currentEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 });
    const onYearStart = startDate.month === 1 && startDate.day === 1;
    const targetYear = dir < 0
      ? (onYearStart ? startDate.year - 1 : startDate.year)
      : (onYearStart ? currentEndDate.year + 1 : currentEndDate.year);
    navigateToYearStart(targetYear);
  }, [currentEndDate, navigateToYearStart]);

  return {
    navigateByMonths,
    navigateToMonth,
    navigateToToday,
    navigateToStart,
    navigateToYearBoundary,
  };
}