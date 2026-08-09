import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { getDaysBetween, getMonthName, getDateFromIndex } from '@/shared/date-utils';
import { getProportionColorHex } from '@/shared/capacity-factor-color-map';
import { CapFacYear } from '@/client/cap-fac-year';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { DATE_BOUNDARIES, PAGE_BACKGROUND_HEX } from '@/shared/config';
import { yearQueryOptions, isValidYear } from '@/client/year-queries';
import { useFleetMode } from '@/client/fleet-mode-context';
import { getRegionNames } from '@/client/cap-fac-stats';
import { emitTooltip, endTooltip } from '@/client/tooltip-bus';
import { useTouchAsHover } from '@/hooks/useTouchAsHover';
import { getPointerPosition } from '@/hooks/useHoverIndicator';

interface CapFacXAxisProps {
  dateRange: { start: CalendarDate; end: CalendarDate };
  regionCode: string;
  onMonthClick?: (year: number, month: number) => void;
  isMobile?: boolean;
}

function CapFacXAxisComponent({
  dateRange,
  regionCode,
  onMonthClick,
  isMobile = false
}: CapFacXAxisProps) {
  const regionNames = getRegionNames(regionCode);
  const tooltipRegionName = isMobile ? regionNames.short : regionNames.long;
  const [useShortLabels, setUseShortLabels] = useState(false);
  const [hoveredMonth, setHoveredMonth] = useState<{ year: number; month: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const monthRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Subscribe to the year(s) the visible range spans; months without loaded
  // data render in the "no data" colour until the query resolves.
  const mode = useFleetMode();
  const queryClient = useQueryClient();
  const startYear = dateRange.start.year;
  const endYear = dateRange.end.year;
  const [leftResult, rightResult] = useQueries({
    queries: [
      {
        ...yearQueryOptions(queryClient, mode, startYear),
        enabled: isValidYear(startYear),
        notifyOnChangeProps: ['data', 'status'] as const,
      },
      {
        ...yearQueryOptions(queryClient, mode, endYear),
        enabled: startYear !== endYear && isValidYear(endYear),
        notifyOnChangeProps: ['data', 'status'] as const,
      },
    ],
  });

  const yearDataMap = new Map<number, CapFacYear>();
  if (leftResult.data) yearDataMap.set(startYear, leftResult.data);
  if (rightResult.data) yearDataMap.set(endYear, rightResult.data);

  // Monitor container width to determine label format
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        // Switch to short labels if average month width is less than 50px
        // 365 days / 12 months ≈ 30.4 days per month on average
        const avgMonthWidth = width / 12;
        const shouldUseShort = avgMonthWidth < 50;
        
        // Only update if value actually changes
        setUseShortLabels(prev => {
          if (prev !== shouldUseShort) {
            return shouldUseShort;
          }
          return prev;
        });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Listen for month hover events from other regions
  useEffect(() => {
    const handleMonthHover = (e: Event) => {
      const customEvent = e as CustomEvent;
      const data = customEvent.detail as { year: number; month: number };
      // Deduped: the re-resolve effect below re-broadcasts whenever the window
      // moves, and a state write per frame would re-render all six axes for a
      // month that hasn't changed.
      setHoveredMonth(prev =>
        prev && prev.year === data.year && prev.month === data.month ? prev : data);
    };

    const handleMonthHoverEnd = () => {
      setHoveredMonth(null);
    };

    window.addEventListener('month-hover', handleMonthHover);
    window.addEventListener('month-hover-end', handleMonthHoverEnd);

    return () => {
      window.removeEventListener('month-hover', handleMonthHover);
      window.removeEventListener('month-hover-end', handleMonthHoverEnd);
    };
  }, []);

  const monthBars: { labelShort: string; labelLong: string; color: string; widthPercent: number; date: CalendarDate; capacityFactor: number | null }[] = [];
  
  // Total days in the date range (should be 365)
  const totalDays = getDaysBetween(dateRange.start, dateRange.end) + 1;
  
  let currentDate = dateRange.start;
  
  while (currentDate.compare(dateRange.end) <= 0) {
    const monthStart = currentDate;
    const year = monthStart.year;
    const month = monthStart.month;
    const monthLabelLong = getMonthName(monthStart);
    const monthLabelShort = monthLabelLong.charAt(0); // First letter only
    
    // Calculate month end
    let monthEnd = monthStart.set({ day: monthStart.calendar.getDaysInMonth(monthStart) });
    if (monthEnd.compare(dateRange.end) > 0) {
      monthEnd = dateRange.end;
    }
    
    // Get capacity factor for this month
    const yearData = yearDataMap.get(year);
    let capacityFactor: number | null = null;
    
    if (yearData && yearData.regionCapacityFactors.has(regionCode)) {
      const monthlyFactors = yearData.regionCapacityFactors.get(regionCode);
      if (monthlyFactors && month >= 1 && month <= 12) {
        capacityFactor = monthlyFactors[month - 1];
      }
    }
    
    // Calculate width as percentage
    const daysInMonth = getDaysBetween(monthStart, monthEnd) + 1;
    const widthPercent = (daysInMonth / totalDays) * 100;
    
    monthBars.push({
      labelShort: monthLabelShort,
      labelLong: monthLabelLong,
      color: getProportionColorHex(capacityFactor),
      widthPercent,
      date: monthStart,
      capacityFactor
    });
    
    // Move to next month
    currentDate = monthStart.add({ months: 1 }).set({ day: 1 });
  }
  
  // The last month broadcast, so the re-resolve below doesn't re-send an
  // identical payload every frame of a pan that stays within one month.
  // Null means "nothing is showing", so re-entering the same cell broadcasts.
  const lastMonthKeyRef = useRef<string | null>(null);

  const emitMonthTooltip = (month: typeof monthBars[0]) => {
    const key = `${month.date.year}-${month.date.month}|${month.capacityFactor}`;
    if (key === lastMonthKeyRef.current) return;
    lastMonthKeyRef.current = key;

    emitTooltip({
      startDate: month.date,
      endDate: null,
      label: tooltipRegionName,
      capacityFactor: month.capacityFactor,
      tooltipType: 'month',
      regionCode: regionCode
    });

    // Broadcast month hover for visual synchronization
    const monthHoverEvent = new CustomEvent('month-hover', {
      detail: {
        year: month.date.year,
        month: month.date.month
      }
    });
    window.dispatchEvent(monthHoverEvent);
  };

  const endMonthTooltip = () => {
    lastMonthKeyRef.current = null;
    endTooltip();
    window.dispatchEvent(new CustomEvent('month-hover-end'));
  };

  const handleMouseEnter = (month: typeof monthBars[0]) => {
    // Clear any hover line from stripes
    document.documentElement.style.removeProperty('--hover-x');
    emitMonthTooltip(month);
  };

  // The months slide under a stationary pointer when the range moves, so
  // re-resolve which cell it is over and re-broadcast — the same trick
  // CompositeTile's paint effect does for the stripes. elementFromPoint rather
  // than a rect scan, because it also proves the cell is the topmost thing
  // there (not behind the sticky header or a dialog).
  //
  // monthBars is deliberately behind a ref and out of the deps: emitMonthTooltip
  // dispatches 'month-hover', which this component listens for and turns into a
  // re-render, and a fresh monthBars array every render would make that a loop.
  const monthBarsRef = useRef(monthBars);
  monthBarsRef.current = monthBars;
  useEffect(() => {
    const pos = getPointerPosition();
    if (!pos) return;
    const element = document.elementFromPoint(pos.x, pos.y);
    const idx = monthRefs.current.indexOf(element as HTMLDivElement | null);
    if (idx >= 0 && monthBarsRef.current[idx]) {
      emitMonthTooltip(monthBarsRef.current[idx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, leftResult.data, rightResult.data]);

  const handleMonthClick = (month: typeof monthBars[0]) => {
    if (onMonthClick) {
      onMonthClick(month.date.year, month.date.month);
    }
  };

  // Touch handlers for hover functionality
  const findMonthAtPosition = (clientX: number, clientY: number) => {
    for (let i = 0; i < monthRefs.current.length; i++) {
      const element = monthRefs.current[i];
      if (element) {
        const rect = element.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && 
            clientY >= rect.top && clientY <= rect.bottom) {
          return monthBars[i];
        }
      }
    }
    return null;
  };

  const touchHandlers = useTouchAsHover({
    onHoverStart: (clientX, clientY) => {
      const month = findMonthAtPosition(clientX, clientY);
      if (month) {
        handleMouseEnter(month);
      }
    },
    onHoverMove: (clientX, clientY) => {
      const month = findMonthAtPosition(clientX, clientY);
      if (month) {
        handleMouseEnter(month);
      } else {
        endMonthTooltip();
      }
    },
    onHoverEnd: endMonthTooltip
  });

  // Page-background overlay for the "no data" ends. Positioned over the same
  // 365-day basis as the stripe canvas above (both fill an equal-width
  // .opennem-stripe-data), so the strip's data→background edge lands on the same
  // vertical line as the canvas. The frontier is the last day with actual data
  // (only the latest data year carries one; a year-end gap in an older year is
  // an interior gap that stays blue).
  const boundaries = useMemo(() => getDateBoundaries(), []);
  const frontierDateForYear = (year: number): CalendarDate | null => {
    const data = yearDataMap.get(year);
    if (!data || year !== boundaries.latestDataYear) return null;
    const idx = data.regionLastDataDayIndex.get(regionCode) ?? -1;
    if (idx < 0 || idx >= data.daysInYear - 1) return null;
    return getDateFromIndex(year, idx);
  };
  const frontierDate = frontierDateForYear(endYear) ?? frontierDateForYear(startYear);
  // The region's first data day in the visible window: months before it (before
  // the region was commissioned) fade to the page background, matching the stripe
  // rows, rather than pale blue.
  const leadingDateForYear = (year: number): CalendarDate | null => {
    const data = yearDataMap.get(year);
    if (!data) return null;
    const idx = data.regionFirstDataDayIndex.get(regionCode) ?? -1;
    if (idx < 0) return null;
    return getDateFromIndex(year, idx);
  };
  const leadingDate = leadingDateForYear(startYear) ?? leadingDateForYear(endYear);
  const clampPct = (v: number) => Math.max(0, Math.min(v, 1)) * 100;
  // A region with no data anywhere in the visible window fades the whole strip to
  // the page background (matching the stripe rows) rather than pale-blue cells.
  // Gated on the spanned year(s) being loaded so a still-loading region isn't
  // prematurely blanked.
  const dataLoaded = !!leftResult.data && (startYear === endYear || !!rightResult.data);
  const regionEmpty = dataLoaded && monthBars.every(m => m.capacityFactor === null);
  const futurePct = regionEmpty
    ? 0
    : frontierDate
      ? clampPct((getDaysBetween(dateRange.start, frontierDate) + 1) / DATE_BOUNDARIES.TILE_WIDTH)
      : 100;
  const pastPct = regionEmpty
    ? 0
    : leadingDate
      ? clampPct(getDaysBetween(dateRange.start, leadingDate) / DATE_BOUNDARIES.TILE_WIDTH)
      : 0;

  return (
    <div className="opennem-stripe-row" style={{ display: 'flex' }}>
      <div className="opennem-facility-label">
        {/* Empty label for alignment */}
      </div>
      <div className="opennem-stripe-data" ref={containerRef} style={{ cursor: 'default' }} {...touchHandlers}>
        <div style={{ display: 'flex', width: '100%', height: '16px' }}>
            {monthBars.map((month, idx) => (
              <div
                key={idx}
                ref={(el) => { monthRefs.current[idx] = el; }}
                className={`opennem-month-label ${hoveredMonth && hoveredMonth.year === month.date.year && hoveredMonth.month === month.date.month ? 'hovered' : ''}`}
                style={{ 
                  backgroundColor: month.color,
                  width: idx === monthBars.length - 1 ? 'auto' : `${month.widthPercent}%`,
                  flex: idx === monthBars.length - 1 ? '1' : 'none',
                  cursor: onMonthClick ? 'pointer' : 'default'
                }}
                onMouseEnter={() => handleMouseEnter(month)}
                onMouseLeave={endMonthTooltip}
                onClick={() => handleMonthClick(month)}
              >
                {useShortLabels ? month.labelShort : month.labelLong}
              </div>
            ))}
        </div>
        {futurePct < 100 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${futurePct}%`,
              right: 0,
              background: PAGE_BACKGROUND_HEX,
              pointerEvents: 'none',
              // Above the month cells: .opennem-month-label sets z-index:10 and,
              // being flex items, that applies despite position:static — without
              // this the blue no-data cells paint over the overlay.
              zIndex: 11,
            }}
          />
        )}
        {pastPct > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: `${pastPct}%`,
              background: PAGE_BACKGROUND_HEX,
              pointerEvents: 'none',
              // Above the month cells: .opennem-month-label sets z-index:10 and,
              // being flex items, that applies despite position:static — without
              // this the blue no-data cells paint over the overlay.
              zIndex: 11,
            }}
          />
        )}
      </div>
    </div>
  );
}
// Memoised so an incidental Home re-render doesn't re-run the month-bar loop
// and re-diff twelve cells per region for nothing. All four props are stable
// between frames: `dateRange` is memoised on the animated end date, and
// `onMonthClick` is a useCallback.
export const CapFacXAxis = React.memo(CapFacXAxisComponent);

CapFacXAxisComponent.displayName = 'CapFacXAxis';
