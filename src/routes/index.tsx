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
import { StripesLegend } from '../components/StripesLegend';
import { useQueries, useQueryClient, type NotifyOnChangeProps } from '@tanstack/react-query';
import { yearQueryOptions } from '@/client/year-queries';
import { loadRosterSnapshot, saveRosterSnapshot, type RosterFacility } from '@/client/roster-snapshot';
import { getRegionNames } from '@/client/cap-fac-stats';
import { FleetModeProvider } from '@/client/fleet-mode-context';
import { endTooltip } from '@/client/tooltip-bus';
import type { FleetMode } from '@/shared/types';
import type { CapFacYear } from '@/client/cap-fac-year';
import { useKeyboardNavigation } from '@/hooks/useKeyboardNavigation';
import { useShortcuts, type ShortcutHandlers } from '@/hooks/useShortcuts';
import type { ShortcutScope } from '@/shared/shortcuts';
import { useGestureSpring, type OffsetEmitMeta } from '@/hooks/useGestureSpring';
import { usePrefetchAdjacentYears } from '@/hooks/usePrefetchAdjacentYears';
import { useRecoverFailedYears } from '@/hooks/useRecoverFailedYears';
import { isFailedYearQuery } from '@/client/failed-year-recovery';
import { useDeviceCapabilities } from '@/hooks/useDeviceCapabilities';
import { useHoverIndicator } from '@/hooks/useHoverIndicator';
import { useHeaderDateRangeTracker } from '@/hooks/useHeaderDateRange';
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
): Map<string, RosterFacility[]> {
  const regionFacilityMaps = new Map<string, Map<string, string>>();
  // Row heights, taken from the built tiles — the very canvas height
  // CompositeTile reserves. Carried in the roster so a cached one (see
  // roster-snapshot) can size next load's rows exactly, with no reflow when the
  // real tiles arrive. Later years win: a facility that gained a unit is taller.
  const heights = new Map<string, number>();
  for (const yearData of yearResults) {
    for (const unit of yearData.data.data) {
      if (unit.region) {
        if (!regionFacilityMaps.has(unit.region)) {
          regionFacilityMaps.set(unit.region, new Map());
        }
        regionFacilityMaps.get(unit.region)!.set(unit.facility_code, unit.facility_name);
      }
    }
    for (const [facilityCode, tile] of yearData.facilityTiles) {
      heights.set(facilityCode, tile.getCanvas().height);
    }
  }

  const facilitiesMap = new Map<string, RosterFacility[]>();
  const sortedRegions = [...ALL_REGION_CODES].sort((a, b) =>
    getRegionNames(a).long.localeCompare(getRegionNames(b).long)
  );
  for (const regionCode of sortedRegions) {
    const facilityMap = regionFacilityMaps.get(regionCode);
    if (facilityMap && facilityMap.size > 0) {
      const sortedFacilities = Array.from(facilityMap.entries())
        .map(([code, name]) => ({ code, name, height: heights.get(code) }))
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
  // Two dates, deliberately. `targetEndDate` is where navigation is HEADED —
  // it moves the instant the user asks, and drives the header and the prefetch.
  // `animatedEndDate` is where the stripes ARE — the spring rewrites it every
  // day-crossing. They differ only while a glide is in flight.
  //
  // `targetEndDateRef` mirrors the target synchronously, because relative moves
  // must compose within a single tick: React state (on a transition lane, no
  // less) would hand two arrow presses the same stale base and swallow the
  // second. See useKeyboardNavigation.getEndDate.
  const [targetEndDate, setTargetEndDate] = useState<CalendarDate | null>(null);
  const targetEndDateRef = useRef<CalendarDate | null>(null);
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
  const pageHeadRef = useRef<HTMLDivElement>(null);

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


  // Offset bounds for the gesture spring (offset 0 = earliestDataEndDay). This
  // is the RENDERED position — it's what a fresh gesture seeds from, so it has
  // to be where the stripes are, not where they're going.
  const boundaries = useMemo(() => getDateBoundaries(), []);
  const currentEndDateForGesture = animatedEndDate || boundaries.latestDataDay;
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

  // Everything below the page head depends on state the server cannot see — the
  // query cache, and localStorage. So the server renders the head and nothing
  // else, and this flag marks the first render that is allowed to know better.
  // It is what keeps the first-visit spinner out of the SSR'd HTML.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  // The roster this device saw last time, read once after hydration (never
  // during SSR, where it doesn't exist and would mismatch). It is the same
  // "hold the last good roster" idea as the ref below, extended across reloads.
  const [snapshotRoster, setSnapshotRoster] = useState<Map<string, RosterFacility[]> | null>(null);
  useEffect(() => {
    setSnapshotRoster(loadRosterSnapshot(mode));
  }, [mode]);

  // Hold the last good roster while a mode switch loads, so the rows don't
  // vanish behind the spinner mid-session. (useQueries takes no
  // placeholderData, so this is the equivalent by hand.)
  //
  // Seeded from the snapshot on a reload, which is what lets the page render its
  // real shell — headers, labels, correctly-sized shimmering rows — before any
  // data has arrived. A live roster always supersedes it on the next render.
  const lastRosterRef = useRef<Map<string, RosterFacility[]>>(new Map());
  const facilitiesByRegion = useMemo(() => {
    if (rosterLoaded) {
      lastRosterRef.current = buildFacilitiesByRegion(
        [rosterLeft, rosterRight].filter(Boolean) as CapFacYear[]
      );
    } else if (lastRosterRef.current.size === 0 && snapshotRoster) {
      lastRosterRef.current = snapshotRoster;
    }
    return lastRosterRef.current;
  }, [rosterLoaded, rosterLeft, rosterRight, snapshotRoster]);

  // Record the shape of the page for the next load. Keyed on the built roster
  // rather than done inside the memo above, which must stay pure.
  useEffect(() => {
    if (rosterLoaded) saveRosterSnapshot(mode, facilitiesByRegion);
  }, [rosterLoaded, facilitiesByRegion, mode]);

  // Gesture spring → rendered date. Offset can be negative for elastic overshoot.
  //
  // Wrapped in startTransition so these per-frame gesture updates land on a
  // transition lane instead of the default lane. React 19's max-update-depth
  // guard only counts sync/continuous/default commits that leave work pending;
  // transition lanes are excluded, so a sustained pan (which fires this ~60×/s,
  // alongside incidental per-frame re-renders from tooltips/query churn) can no
  // longer climb the nested-update counter and freeze the tab.
  //
  // A non-transient offset — a finger mid-drag, a wheel mid-pan, a settled rest
  // — is the target as well as the position, so it moves both. A spring or
  // glide frame is only ever the position: its target was already announced by
  // handleNavigationTarget, and letting an en-route frame overwrite it is
  // exactly the bug this split exists to kill.
  const handleOffsetChange = useCallback((offset: number, meta: OffsetEmitMeta) => {
    const date = boundaries.earliestDataEndDay.add({ days: offset });
    if (!meta.isTransient) targetEndDateRef.current = date;
    startTransition(() => {
      setAnimatedEndDate(date);
      setIsDragging(meta.isDragging);
      if (!meta.isTransient) setTargetEndDate(date);
    });
  }, [boundaries]);

  // A new destination is known. Urgent and outside the transition — this is the
  // keystroke's whole payload, and it must not queue behind the pan's deferred
  // work. Safe to keep urgent because it fires only at discrete moments
  // (keypress, month click, gesture release), never per frame.
  const handleNavigationTarget = useCallback((offset: number) => {
    const date = boundaries.earliestDataEndDay.add({ days: offset });
    targetEndDateRef.current = date;
    setTargetEndDate(date);
  }, [boundaries]);

  // Unified gesture + spring navigation: drag, wheel, touch, and programmatic.
  const { bind, elementRef, navigateToOffset } = useGestureSpring({
    currentOffset,
    maxOffset,
    onOffsetChange: handleOffsetChange,
    onNavigationTarget: handleNavigationTarget,
  });

  // Animate to an absolute end date through the same spring (keyboard + months).
  const navigateToDate = useCallback((date: CalendarDate) => {
    navigateToOffset(getDaysBetween(boundaries.earliestDataEndDay, date));
  }, [boundaries, navigateToOffset]);

  // Timeline navigation actions, all driving the same spring via navigateToDate.
  // They read the target through a ref, so relative moves compose no matter how
  // far behind React's commits are.
  const getTargetEndDate = useCallback(() => targetEndDateRef.current, []);
  const {
    navigateByMonths,
    navigateToMonth,
    navigateToToday,
    navigateToStart,
    navigateToYearBoundary,
  } = useKeyboardNavigation({
    getEndDate: getTargetEndDate,
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
    (!welcomeOpen && !shortcutsOpen && !isDragging && targetEndDate !== null)
  ), [welcomeOpen, shortcutsOpen, isDragging, targetEndDate]);

  useShortcuts(shortcutHandlers, { capabilities, isScopeActive });

  // One pointer-tracking listener for the whole page, driving --hover-x.
  useHoverIndicator();

  // Hand the date range readout to the pinned region header once the page-head
  // copy has scrolled behind the top bar. Publishes to a store rather than
  // state, so a region boundary doesn't re-render the whole page.
  // `ready` mirrors the loading gate below — the observers need the real DOM,
  // not the spinner that stands in for it.
  const regionCodes = useMemo(() => Array.from(facilitiesByRegion.keys()), [facilitiesByRegion]);
  useHeaderDateRangeTracker({
    pageHeadRef,
    vizRef: containerRef,
    regionCodes,
    ready: regionCodes.length > 0 && targetEndDate !== null && animatedEndDate !== null,
  });

  // Target date range — the header and the prefetch both want the destination,
  // so they update on the keystroke rather than trailing the glide. Memoised for
  // the same reason as animatedDateRange above: RegionTooltip is React.memo'd,
  // and a fresh object every render would defeat that on every frame of a pan.
  const targetDateRange = useMemo(
    () => targetEndDate
      ? {
          start: targetEndDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }),
          end: targetEndDate,
        }
      : null,
    [targetEndDate]
  );

  // Prefetch the years around the settled navigation target so scrolling the
  // timeline rarely waits on the network.
  usePrefetchAdjacentYears(
    mode,
    targetDateRange?.start.year ?? null,
    targetDateRange?.end.year ?? null
  );

  // Retry years that have exhausted the fetch layer's own attempts. Without
  // this a year that fails while on screen stays a pale-blue block until the
  // page is reloaded — nothing else re-fetches a query the reader is already
  // watching.
  useRecoverFailedYears();

  // On the first load, position the timeline. On a later mode switch, keep the
  // current navigation target (hence `prev ??`).
  //
  // Deliberately independent of the data: both dates are just
  // `boundaries.latestDataDay`, so waiting on `rosterLoaded` held the header,
  // the date range and every row behind the spinner for a network round trip
  // they never needed.
  //
  // Still an effect rather than a useState initialiser, though, because
  // latestDataDay is today-dependent (getTodayAEST() − 1) while the SSR document
  // is edge-cached for an hour: an initialiser would hydration-mismatch against
  // an hour-old document across AEST midnight.
  useEffect(() => {
    targetEndDateRef.current ??= boundaries.latestDataDay;
    setTargetEndDate(prev => prev ?? boundaries.latestDataDay);
    setAnimatedEndDate(prev => prev ?? boundaries.latestDataDay);
  }, [boundaries]);


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
        target.closest('.opennem-facility-label') ||
        target.closest('.facility-hovercard') ||
        target.closest('.opennem-facility-canvas') ||
        target.closest('.opennem-month-label') ||
        target.closest('.tooltip-container');

      // If touching outside interactive elements, clear any pinned tooltips
      if (!isInteractiveElement) {
        endTooltip();
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

  // Only when there is nothing to show. A roster year can fail on a *background
  // revalidation* (staleTime is an hour for the current year), and replacing an
  // already-rendered timeline with a full-page error over that would be a far
  // worse failure than the pale-blue tile the error otherwise degrades to.
  if (rosterError && facilitiesByRegion.size === 0) {
    return (
      <div className="opennem-error">
        <div>
          <h2>Unable to load data</h2>
          <p>{rosterError instanceof Error ? rosterError.message : 'Failed to load data'}</p>
          <button
            className="oe-button"
            onClick={() => {
              void queryClient.refetchQueries({ predicate: isFailedYearQuery });
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Rows can be drawn as soon as the page's SHAPE is known — from a live roster
  // or, on a reload, from the snapshot — which is well before the stripes
  // themselves arrive. The rows that have no data yet shimmer (CompositeTile),
  // at the heights the roster records, so nothing reflows when they fill in.
  const canDrawRows = facilitiesByRegion.size > 0 && targetEndDate !== null && animatedEndDate !== null;

  return (
    <FleetModeProvider value={mode}>
      {/* Performance Monitor. Client-only: it seeds its state from
          localStorage, which the server can't see. */}
      {hydrated && <PerformanceDisplay />}

      {/* Header + date range. Grouped so the sticky header's scope ends exactly
          at the top of the viz below — that's what makes the first region header
          push the page header out of view instead of sliding over it. See
          `.opennem-page-head` in opennem.css.

          Rendered unconditionally, including on the server, so it is in the HTML
          itself: on a reload the top of the page is painted before a single line
          of JavaScript runs, and never moves again. */}
      <div className="opennem-page-head" ref={pageHeadRef}>
        <OpenElectricityHeader
          onOpenHelp={openWelcome}
          fleetMode={mode}
          onFleetModeChange={setMode}
        />

        {/* Legend + date range. Siblings, deliberately: the e2e suite reads
            `.opennem-date-range`'s textContent to watch the range change, so
            nothing else may be nested inside it. */}
        <div className="opennem-stripes-container">
          <div className="opennem-stripes-header">
            <StripesLegend />
            <DateRange dateRange={targetDateRange} />
          </div>
        </div>
      </div>

      {canDrawRows ? (
        <div className="opennem-stripes-container">
          {/* Main Stripes Visualisation. data-offset is where the stripes ARE;
              data-target-offset is where they're headed — they agree except
              mid-glide, and the e2e suite asserts on both. */}
          <div
            ref={(el) => {
              containerRef.current = el;
              elementRef.current = el;
            }}
            data-testid="stripes-viz"
            data-offset={Math.round(currentOffset)}
            data-target-offset={Math.round(
              getDaysBetween(boundaries.earliestDataEndDay, targetEndDate)
            )}
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
                  endDate={animatedEndDate}
                  animatedDateRange={animatedDateRange}
                  targetDateRange={targetDateRange}
                  onMonthClick={handleMonthClick}
                  isMobile={isMobile}
                />
              );
            })}

            {/* Bottom spacer */}
            <div style={{ height: '50px', clear: 'both' }} />
          </div>
        </div>
      ) : hydrated ? (
        // A device that has genuinely never loaded this page: no roster, no
        // snapshot, nothing to draw. `hydrated` is what keeps this off the
        // server — rendering it there put "Loading stripes…" in the HTML, so it
        // painted on every single load, refreshes included, whether or not any
        // data was actually missing.
        <div className="opennem-loading">
          <div className="opennem-loading-spinner"></div>
          Loading stripes…
        </div>
      ) : null}

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
