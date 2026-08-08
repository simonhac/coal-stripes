import React, { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CalendarDate } from '@internationalized/date';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { getDaysBetween } from '@/shared/date-utils';
import { DATE_BOUNDARIES } from '@/shared/config';
import { PerformanceDisplay } from '../components/PerformanceDisplay';
import { OpenElectricityHeader } from '../components/OpenElectricityHeader';
import { RegionSection } from '../components/RegionSection';
import { DateRange } from '../components/DateRange';
import { useQueries, useQueryClient, type NotifyOnChangeProps } from '@tanstack/react-query';
import { yearQueryOptions } from '@/client/year-queries';
import { getRegionNames } from '@/client/cap-fac-stats';
import { FleetModeProvider } from '@/client/fleet-mode-context';
import type { FleetMode } from '@/shared/types';
import type { CapFacYear } from '@/client/cap-fac-year';
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation';
import { useShortcuts, type ShortcutHandlers } from '@/hooks/useShortcuts';
import type { ShortcutScope } from '@/shared/shortcuts';
import { useGestureSpring } from '@/hooks/useGestureSpring';
import { usePrefetchAdjacentYears } from '@/hooks/usePrefetchAdjacentYears';
import { useDeviceCapabilities } from '@/hooks/useDeviceCapabilities';
import { useHoverIndicator } from '@/hooks/useHoverIndicator';
import { hasSeenWelcome, markWelcomeSeen } from '@/shared/welcome-state';
import { WelcomeDialog } from '../components/WelcomeDialog';
import { ShortcutsDialog } from '../components/ShortcutsDialog';

// Region display order is fixed; a region only appears if it has facilities.
const ALL_REGION_CODES = ['NSW1', 'QLD1', 'SA1', 'TAS1', 'VIC1', 'WEM'];

// Background-refetch fetchStatus churn must not re-render the whole page.
// Typed (not `as const`) because useQueries' mapped-array form wants a mutable
// NotifyOnChangeProps, unlike its fixed-tuple form.
const ROSTER_NOTIFY_ON: NotifyOnChangeProps = ['data', 'status'];

// Build the region → facilities roster from one or more years of data. The
// roster (which rows exist) is derived from the loaded DTO(s); in `full` mode
// the current-year DTO already carries every unit that ever operated (retired
// units appear as all-null rows), so this naturally yields the full historical
// roster including SA1 and retired plants.
function buildFacilitiesByRegion(
  yearResults: CapFacYear[]
): Map<string, { code: string; name: string }[]> {
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

  const facilitiesMap = new Map<string, { code: string; name: string }[]>();
  const sortedRegions = [...ALL_REGION_CODES].sort((a, b) =>
    getRegionNames(a).long.localeCompare(getRegionNames(b).long)
  );
  for (const regionCode of sortedRegions) {
    const facilityMap = regionFacilityMaps.get(regionCode);
    if (facilityMap && facilityMap.size > 0) {
      const sortedFacilities = Array.from(facilityMap.entries())
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      facilitiesMap.set(regionCode, sortedFacilities);
    }
  }
  return facilitiesMap;
}

/**
 * `?fleet=` is the one piece of view state that lives in the URL, so a view is
 * shareable. Validating it here makes it typed everywhere downstream, and
 * replaces the pair of effects the Next version needed — a mount-only read plus
 * a `history.replaceState` mirror — which existed solely to keep the server and
 * client renders identical. The router resolves search params before render, so
 * there is nothing to hydrate around.
 *
 * Anything other than `current` normalises to the default rather than erroring:
 * an old bookmark should still show the page.
 */
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { fleet?: 'current' } =>
    search.fleet === 'current' ? { fleet: 'current' } : {},
  component: Home,
});

function Home() {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const [endDate, setEndDate] = useState<CalendarDate | null>(null);
  const [animatedEndDate, setAnimatedEndDate] = useState<CalendarDate | null>(null);

  // Fleet roster mode, read straight from the URL rather than mirrored into
  // component state. `full` (every unit that ever operated) is the default and
  // is represented by the absence of the parameter, so the canonical URL stays
  // clean.
  const { fleet } = Route.useSearch();
  const mode: FleetMode = fleet ?? 'full';
  const setMode = useCallback(
    (next: FleetMode) => {
      navigate({
        search: next === 'full' ? {} : { fleet: next },
        // Toggling the fleet view shouldn't leave a trail to back through.
        replace: true,
      });
    },
    [navigate],
  );
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

  // Calculate animated date range from animatedEndDate. Memoised on the end
  // date so an incidental Home re-render doesn't hand every CompositeTile a new
  // dateRange object and re-run its per-frame paint effect for no reason.
  const animatedDateRange = useMemo(
    () => animatedEndDate
      ? {
          start: animatedEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
          end: animatedEndDate,
        }
      : null,
    [animatedEndDate]
  );

  // Handle date navigation — sets the target (header) and the rendered date
  // (tiles) together so header and tiles always move in lock-step.
  //
  // Wrapped in startTransition so these per-frame gesture updates land on a
  // transition lane instead of the default lane. React 19's max-update-depth
  // guard only counts sync/continuous/default commits that leave work pending;
  // transition lanes are excluded, so a sustained pan (which fires this ~60×/s,
  // alongside incidental per-frame re-renders from tooltips/query churn) can no
  // longer climb the nested-update counter and freeze the tab. All three
  // setStates share the one transition, so header and tiles stay in lock-step.
  const handleDateNavigate = useCallback((newEndDate: CalendarDate, dragging: boolean) => {
    startTransition(() => {
      setEndDate(newEndDate);
      setIsDragging(dragging);
      setAnimatedEndDate(newEndDate);
    });
  }, []);

  // Offset bounds for the gesture spring (offset 0 = earliestDataEndDay).
  const boundaries = useMemo(() => getDateBoundaries(), []);
  const currentEndDateForGesture = endDate || boundaries.latestDataDay;
  const currentOffset = getDaysBetween(boundaries.earliestDataEndDay, currentEndDateForGesture);
  const maxOffset = getDaysBetween(boundaries.earliestDataEndDay, boundaries.latestDataDay);

  // The roster (which facility rows exist) is always derived from the CURRENT
  // year's data — independent of what year is being viewed — so panning never
  // changes the row set. Switching mode swaps the whole roster (e.g. SA1 and
  // retired plants appear in `full`).
  const rosterYears = useMemo(() => {
    const end = boundaries.latestDataDay;
    const start = end.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 });
    return start.year === end.year ? [start.year] : [start.year, end.year];
  }, [boundaries]);

  const rosterResults = useQueries({
    queries: rosterYears.map(year => ({
      ...yearQueryOptions(queryClient, mode, year),
      notifyOnChangeProps: ROSTER_NOTIFY_ON,
    })),
  });

  // Destructured rather than used as an array, because useQueries hands back a
  // fresh array every render while the individual `data` references are stable.
  const rosterLeft = rosterResults[0]?.data;
  const rosterRight = rosterResults[1]?.data;
  const rosterError = rosterResults.find(r => r.error)?.error ?? null;
  const rosterLoaded = rosterLeft !== undefined && (rosterYears.length === 1 || rosterRight !== undefined);

  // Hold the last good roster while a mode switch loads, so the rows don't
  // vanish behind the spinner mid-session. (useQueries takes no
  // placeholderData, so this is the equivalent by hand.)
  const lastRosterRef = useRef<Map<string, { code: string; name: string }[]>>(new Map());
  const facilitiesByRegion = useMemo(() => {
    if (rosterLoaded) {
      lastRosterRef.current = buildFacilitiesByRegion(
        [rosterLeft, rosterRight].filter(Boolean) as CapFacYear[]
      );
    }
    return lastRosterRef.current;
  }, [rosterLoaded, rosterLeft, rosterRight]);

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

  // Timeline navigation actions, all driving the same spring via navigateToDate.
  const {
    navigateByMonths,
    navigateToMonth,
    navigateToToday,
    navigateToStart,
    navigateToYearBoundary,
  } = useKeyboardNavigation({
    currentEndDate: endDate,
    navigateToDate,
  });
  const handleMonthClick = navigateToMonth;

  // Bind the shortcut registry. `navigation` shortcuts go inert while a dialog
  // is open (so arrows don't scrub the timeline behind the modal), while a drag
  // is in flight, and before the first data load settles an end date. `global`
  // ones stay live, which is how `a` / `?` close the dialog they opened.
  const shortcutHandlers = useMemo<ShortcutHandlers>(() => ({
    stepMonth: (months) => navigateByMonths(months ?? 0),
    stepSixMonths: (months) => navigateByMonths(months ?? 0),
    yearBoundary: (dir) => navigateToYearBoundary(dir ?? 0),
    toLatest: () => navigateToToday(),
    toStart: () => navigateToStart(),
    toggleShortcuts: () => (shortcutsOpen ? setShortcutsOpen(false) : openShortcuts()),
    toggleWelcome: () => (welcomeOpen ? setWelcomeOpen(false) : openWelcome()),
  }), [
    navigateByMonths, navigateToYearBoundary, navigateToToday, navigateToStart,
    shortcutsOpen, welcomeOpen, openShortcuts, openWelcome,
  ]);

  const isScopeActive = useCallback((scope: ShortcutScope) => (
    scope === 'global' ||
    (!welcomeOpen && !shortcutsOpen && !isDragging && endDate !== null)
  ), [welcomeOpen, shortcutsOpen, isDragging, endDate]);

  useShortcuts(shortcutHandlers, { capabilities, isScopeActive });

  // One pointer-tracking listener for the whole page, driving --hover-x.
  useHoverIndicator();

  // Target date range (for display in header)
  const targetDateRange = endDate ? {
    start: endDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
    end: endDate
  } : null;

  // Prefetch the years around the settled navigation target so scrolling the
  // timeline rarely waits on the network.
  usePrefetchAdjacentYears(
    mode,
    targetDateRange?.start.year ?? null,
    targetDateRange?.end.year ?? null
  );

  // On the first load, position the timeline. On a later mode switch, keep the
  // current navigation target.
  useEffect(() => {
    if (!rosterLoaded) return;
    setEndDate(prev => prev ?? boundaries.latestDataDay);
    setAnimatedEndDate(prev => prev ?? boundaries.latestDataDay);
  }, [rosterLoaded, boundaries]);


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

  if (rosterError) {
    return (
      <div className="opennem-error">
        <div>
          <h2>Unable to load data</h2>
          <p>{rosterError instanceof Error ? rosterError.message : 'Failed to load data'}</p>
          <button onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Gate on having *a* roster rather than a freshly-loaded one, so a mode
  // switch keeps the current rows on screen instead of flashing the spinner.
  // endDate is settled by an effect once the first roster lands.
  if (facilitiesByRegion.size === 0 || !endDate) {
    return (
      <div className="opennem-loading">
        <div className="opennem-loading-spinner"></div>
        Loading stripes data...
      </div>
    );
  }

  return (
    <FleetModeProvider value={mode}>
      {/* Performance Monitor */}
      <PerformanceDisplay />

      {/* Header */}
      <OpenElectricityHeader
        onOpenHelp={openWelcome}
        fleetMode={mode}
        onFleetModeChange={setMode}
      />

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
    </FleetModeProvider>
  );
}
