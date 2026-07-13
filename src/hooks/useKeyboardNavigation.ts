import { useCallback, useEffect } from 'react';
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
  isDragging?: boolean;
  disabled?: boolean;
}

/**
 * Hook for handling keyboard navigation.
 * Delegates the actual animation to the shared gesture spring via `navigateToDate`
 * so keyboard, month-clicks, drag, and wheel all move through one animator.
 */
export function useKeyboardNavigation({
  currentEndDate,
  navigateToDate,
  isDragging = false,
  disabled = false,
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

  // Keyboard event handler
  useEffect(() => {
    if (disabled) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Don't handle keyboard navigation while dragging
      if (isDragging) return;

      // Only handle if we have an end date
      if (!currentEndDate) return;

      const isShift = e.shiftKey;
      const isCmd = e.metaKey || e.ctrlKey; // Support both Mac (Cmd) and Windows/Linux (Ctrl)
      const monthsToMove = isShift ? 6 : 1;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (isCmd) {
          // Command+Left: Go to Jan 1 of start year (or previous year if already Jan 1)
          const startDate = currentEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 });
          const targetYear = (startDate.month === 1 && startDate.day === 1) 
            ? startDate.year - 1 
            : startDate.year;
          navigateToYearStart(targetYear);
        } else {
          navigateByMonths(-monthsToMove);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (isCmd) {
          // Command+Right: Go to Jan 1 of end year (or next year if start date is already Jan 1)
          const startDate = currentEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 });
          const targetYear = (startDate.month === 1 && startDate.day === 1) 
            ? currentEndDate.year + 1 
            : currentEndDate.year;
          navigateToYearStart(targetYear);
        } else {
          navigateByMonths(monthsToMove);
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        navigateToToday();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        navigateToToday();
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        navigateToStart();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentEndDate, navigateByMonths, navigateToToday, navigateToYearStart, navigateToStart, isDragging, disabled]);

  return { navigateToMonth };
}