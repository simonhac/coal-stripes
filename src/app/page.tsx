'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CalendarDate } from '@internationalized/date';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { getDaysBetween } from '@/shared/date-utils';
import { DATE_BOUNDARIES } from '@/shared/config';
import { PerformanceDisplay } from '../components/PerformanceDisplay';
import { OpenElectricityHeader } from '../components/OpenElectricityHeader';
import { RegionSection } from '../components/RegionSection';
import { DateRange } from '../components/DateRange';
import { yearDataVendor, getRegionNames } from '@/client/year-data-vendor';
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation';
import { useGestureSpring } from '@/hooks/useGestureSpring';
import './opennem.css';

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<CalendarDate | null>(null);
  const [animatedEndDate, setAnimatedEndDate] = useState<CalendarDate | null>(null);
  const [facilitiesByRegion, setFacilitiesByRegion] = useState<Map<string, { code: string; name: string }[]>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Calculate animated date range from animatedEndDate
  const animatedDateRange = animatedEndDate ? {
    start: animatedEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
    end: animatedEndDate
  } : null;

  // Handle date navigation — sets the target (header) and the rendered date
  // (tiles) together so header and tiles always move in lock-step.
  const handleDateNavigate = useCallback((newEndDate: CalendarDate, dragging: boolean) => {
    setEndDate(newEndDate);
    setIsDragging(dragging);
    setAnimatedEndDate(newEndDate);
  }, []);

  // Offset bounds for the gesture spring (offset 0 = earliestDataEndDay).
  const boundaries = useMemo(() => getDateBoundaries(), []);
  const currentEndDateForGesture = endDate || boundaries.latestDataDay;
  const currentOffset = getDaysBetween(boundaries.earliestDataEndDay, currentEndDateForGesture);
  const maxOffset = getDaysBetween(boundaries.earliestDataEndDay, boundaries.latestDataDay);

  // Gesture spring → date. Offset can be negative for elastic overshoot.
  const handleOffsetChange = useCallback((offset: number, dragging: boolean) => {
    handleDateNavigate(boundaries.earliestDataEndDay.add({ days: offset }), dragging);
  }, [boundaries, handleDateNavigate]);

  // Unified gesture + spring navigation: drag, wheel, touch, and programmatic.
  const { bind, elementRef, navigateToOffset } = useGestureSpring({
    currentOffset,
    maxOffset,
    onOffsetChange: handleOffsetChange,
  });

  // Animate to an absolute end date through the same spring (keyboard + months).
  const navigateToDate = useCallback((date: CalendarDate) => {
    navigateToOffset(getDaysBetween(boundaries.earliestDataEndDay, date));
  }, [boundaries, navigateToOffset]);

  // Keyboard navigation drives the same spring via navigateToDate.
  const { navigateToMonth } = useKeyboardNavigation({
    currentEndDate: endDate,
    navigateToDate,
    isDragging,
  });
  const handleMonthClick = navigateToMonth;

  // Target date range (for display in header)
  const targetDateRange = endDate ? {
    start: endDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
    end: endDate
  } : null;
  // Initial load
  useEffect(() => {
    async function initialLoad() {
      try {
        // Calculate end date and determine which years we need
        const boundaries = getDateBoundaries();
        const calculatedEndDate = boundaries.latestDataDay;
        const startDate = calculatedEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }); // For determining which years to load

        // Determine which years we need
        const startYear = startDate.year;
        const endYear = calculatedEndDate.year;
        const years = startYear === endYear ? [startYear] : [startYear, endYear];

        // Load all required years
        const yearPromises = years.map(year => yearDataVendor.requestYear(year));
        const yearResults = await Promise.all(yearPromises);

        // Extract facilities by region from the loaded data
        const regionFacilityMaps = new Map<string, Map<string, string>>();

        for (const yearData of yearResults) {
          for (const unit of yearData.data.data) {
            if (unit.region) {
              if (!regionFacilityMaps.has(unit.region)) {
                regionFacilityMaps.set(unit.region, new Map());
              }
              regionFacilityMaps.get(unit.region)!.set(unit.facility_code, unit.facility_name);
            }
          }
        }

        // Convert to sorted structure
        const facilitiesMap = new Map<string, { code: string; name: string }[]>();

        // Get all region codes and sort alphabetically by long name
        const allRegionCodes = ['NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1', 'WEM'];
        const sortedRegions = allRegionCodes
          .sort((a, b) => getRegionNames(a).long.localeCompare(getRegionNames(b).long));

        // Process each region
        for (const regionCode of sortedRegions) {
          const facilityMap = regionFacilityMaps.get(regionCode);
          if (facilityMap && facilityMap.size > 0) {
            const sortedFacilities = Array.from(facilityMap.entries())
              .map(([code, name]) => ({ code, name }))
              .sort((a, b) => a.name.localeCompare(b.name));
            facilitiesMap.set(regionCode, sortedFacilities);
          }
        }

        setFacilitiesByRegion(facilitiesMap);

        // Only set end date after data is loaded
        setEndDate(calculatedEndDate);
        setAnimatedEndDate(calculatedEndDate);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load initial data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load initial data');
        setLoading(false);
      }
    }

    initialLoad();
  }, []);


  // Ensure the page has focus on mount for keyboard navigation
  useEffect(() => {
    window.focus();
  }, []);

  // Clear pinned tooltips when touching outside interactive elements
  useEffect(() => {
    const handleGlobalTouch = (e: TouchEvent) => {
      const target = e.target as HTMLElement;

      // Check if the touch is on an interactive element
      const isInteractiveElement =
        target.closest('.opennem-facility-label') ||
        target.closest('.opennem-region-label') ||
        target.closest('.opennem-facility-canvas') ||
        target.closest('.opennem-month-label') ||
        target.closest('.tooltip-container');

      // If touching outside interactive elements, clear any pinned tooltips
      if (!isInteractiveElement) {
        const event = new CustomEvent('tooltip-data-hover-end');
        window.dispatchEvent(event);
      }
    };

    document.addEventListener('touchstart', handleGlobalTouch);

    return () => {
      document.removeEventListener('touchstart', handleGlobalTouch);
    };
  }, []);

  // Detect mobile screen width
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
    };
  }, []);


  if (loading) {
    return (
      <div className="opennem-loading">
        <div className="opennem-loading-spinner"></div>
        Loading stripes data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="opennem-error">
        <div>
          <h2>Unable to load data</h2>
          <p>{error}</p>
          <button onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Performance Monitor */}
      <PerformanceDisplay />

      {/* Header */}
      <OpenElectricityHeader />

      {/* Date Range Header */}
      <div className="opennem-stripes-container">
        <div className="opennem-stripes-header">
          <DateRange dateRange={targetDateRange} />
        </div>

        {/* Main Stripes Visualization */}
        <div
          ref={(el) => {
            containerRef.current = el;
            elementRef.current = el;
          }}
          data-testid="stripes-viz"
          data-offset={Math.round(currentOffset)}
          data-max-offset={maxOffset}
          className="opennem-stripes-viz"
          style={{ touchAction: 'none' }}
          {...bind()}
        >
          {/* Create a section for each region */}
          {Array.from(facilitiesByRegion.entries()).map(([regionCode, facilities]) => {
            return (
              <RegionSection
                key={regionCode}
                regionCode={regionCode}
                facilities={facilities}
                endDate={endDate!}
                animatedDateRange={animatedDateRange}
                onMonthClick={handleMonthClick}
                isMobile={isMobile}
              />
            );
          })}

          {/* Bottom spacer */}
          <div style={{ height: '50px', clear: 'both' }} />
        </div>
      </div>
    </>
  );
}
