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
import { useQueryClient } from '@tanstack/react-query';
import { yearQueryOptions } from '@/client/year-queries';
import { getRegionNames } from '@/client/cap-fac-stats';
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation';
import { useGestureSpring } from '@/hooks/useGestureSpring';
import { usePrefetchAdjacentYears } from '@/hooks/usePrefetchAdjacentYears';
import { useDeviceCapabilities } from '@/hooks/useDeviceCapabilities';
import { hasSeenWelcome, markWelcomeSeen } from '@/shared/welcome-state';
import { WelcomeDialog } from '../components/WelcomeDialog';
import { ShortcutsDialog } from '../components/ShortcutsDialog';
import './opennem.css';

export default function Home() {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<CalendarDate | null>(null);
  const [animatedEndDate, setAnimatedEndDate] = useState<CalendarDate | null>(null);
  const [facilitiesByRegion, setFacilitiesByRegion] = useState<Map<string, { code: string; name: string }[]>>(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Onboarding / help dialogs
  const capabilities = useDeviceCapabilities();
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Mutually exclusive: opening one closes the other, so at most one is open.
  const openWelcome = useCallback(() => {
    setShortcutsOpen(false);
    setWelcomeOpen(true);
  }, []);
  const openShortcuts = useCallback(() => {
    setWelcomeOpen(false);
    setShortcutsOpen(true);
  }, []);

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
  // Disabled while a dialog is open so arrows/Home/t/s don't scrub the timeline
  // behind the modal.
  const { navigateToMonth } = useKeyboardNavigation({
    currentEndDate: endDate,
    navigateToDate,
    isDragging,
    disabled: welcomeOpen || shortcutsOpen,
  });
  const handleMonthClick = navigateToMonth;

  // Target date range (for display in header)
  const targetDateRange = endDate ? {
    start: endDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
    end: endDate
  } : null;

  // Prefetch the years around the settled navigation target so scrolling the
  // timeline rarely waits on the network.
  usePrefetchAdjacentYears(
    targetDateRange?.start.year ?? null,
    targetDateRange?.end.year ?? null
  );

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

        // Load all required years (fetchQuery dedupes with any fetch the
        // tiles kick off for the same year)
        const yearResults = await Promise.all(
          years.map(year => queryClient.fetchQuery(yearQueryOptions(year)))
        );

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
  }, [queryClient]);


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

  // Show the welcome dialog on a visitor's first arrival (once, via localStorage).
  useEffect(() => {
    if (!hasSeenWelcome()) {
      setWelcomeOpen(true);
      markWelcomeSeen(); // record on open so a mid-dialog reload won't re-nag
    }
  }, []);

  // Global hotkeys: 'a' toggles the welcome dialog, '?' toggles shortcuts.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // Ignore chords so we don't clobber ⌘A / Ctrl+A etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        if (welcomeOpen) setWelcomeOpen(false);
        else openWelcome();
      } else if (e.key === '?' && capabilities.hasKeyboard) {
        // '?' is typically Shift+/, so match the produced character.
        e.preventDefault();
        if (shortcutsOpen) setShortcutsOpen(false);
        else openShortcuts();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [welcomeOpen, shortcutsOpen, capabilities.hasKeyboard, openWelcome, openShortcuts]);


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
      <OpenElectricityHeader onOpenHelp={openWelcome} />

      {/* Date Range Header */}
      <div className="opennem-stripes-container">
        <div className="opennem-stripes-header">
          <DateRange dateRange={targetDateRange} />
        </div>

        {/* Main Stripes Visualisation */}
        <div
          ref={(el) => {
            containerRef.current = el;
            elementRef.current = el;
          }}
          data-testid="stripes-viz"
          data-offset={Math.round(currentOffset)}
          data-max-offset={maxOffset}
          className="opennem-stripes-viz"
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

      {/* Onboarding / help dialogs */}
      <WelcomeDialog
        isOpen={welcomeOpen}
        onClose={() => setWelcomeOpen(false)}
        capabilities={capabilities}
        onOpenShortcuts={openShortcuts}
      />
      <ShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        capabilities={capabilities}
      />
    </>
  );
}
