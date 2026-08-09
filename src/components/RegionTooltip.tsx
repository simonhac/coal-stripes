import React, { useState, useEffect, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { CapFacTooltip, TooltipSource } from './CapFacTooltip';
import { RegionHeaderDateRange } from './DateRange';
import { getRegionNames } from '@/client/cap-fac-stats';
import { resolveTooltip } from '@/client/tooltip-resolve';
import { subscribeTooltip } from '@/client/tooltip-bus';
import { yearQueryOptions, isValidYear } from '@/client/year-queries';
import { useFleetMode } from '@/client/fleet-mode-context';
import { useHeaderDateRangeSlot } from '@/hooks/useHeaderDateRange';

interface RegionTooltipProps {
  regionCode: string;
  isMobile: boolean;
  /**
   * Where the stripes ARE. A period tooltip describes the window on screen, so
   * it counts along with a glide rather than jumping to its destination.
   */
  animatedDateRange: { start: CalendarDate; end: CalendarDate } | null;
  /**
   * Where navigation is HEADED — shown when this header borrows the date range
   * slot. Deliberately the other one: the borrowed readout stands in for the
   * page-head copy, which has always shown the destination.
   */
  targetDateRange: { start: CalendarDate; end: CalendarDate } | null;
}

/**
 * One region's tooltip, and the hover subscription that feeds it.
 *
 * Deliberately a leaf. The subscription used to sit in RegionSection, so every
 * hover re-rendered the whole section — its region label, every facility label,
 * every tile and the month axis — when the only thing that had changed was the
 * tooltip. Subscribing down here keeps a hover to six re-renders across the
 * page instead of forty-odd.
 *
 * What arrives on the bus is a description of what is being pointed at, never a
 * snapshot of what it was worth; the numbers and dates are derived here, at
 * render, from the window currently on screen. That is what lets a tooltip keep
 * up when the range moves under a stationary pointer — or under no pointer at
 * all, while pinned.
 *
 * It also owns the other thing that can occupy this slot: once the page-head
 * date range has scrolled out of sight, the pinned region's header shows the
 * date range here instead — a tooltip, when there is one, always wins.
 */
function RegionTooltipComponent({
  regionCode,
  isMobile,
  animatedDateRange,
  targetDateRange
}: RegionTooltipProps) {
  const queryClient = useQueryClient();
  const mode = useFleetMode();
  const [source, setSource] = useState<TooltipSource | null>(null);
  const showDateRange = useHeaderDateRangeSlot(regionCode);

  const regionNames = getRegionNames(regionCode);
  const tooltipRegionName = isMobile ? regionNames.short : regionNames.long;

  // Every region hears every broadcast: the pointed-at one shows what the
  // pointer resolved, the rest answer the same question for themselves. Keep it
  // unconditional — the six headers appear and disappear together.
  useEffect(() => subscribeTooltip(setSource, () => setSource(null)), []);

  // A fleet-mode switch changes the numbers under a pinned tooltip, and can
  // remove the facility it points at altogether.
  useEffect(() => setSource(null), [mode]);

  // Subscribe to the displayed year(s) so a value that resolved to an em dash on
  // a cold year fills itself in when the data lands. No extra network: every
  // CompositeTile in this region already holds these queries.
  const startYear = animatedDateRange?.start.year ?? 0;
  const endYear = animatedDateRange?.end.year ?? 0;
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

  const tooltipData = useMemo(
    () => resolveTooltip({
      source,
      regionCode,
      regionLabel: tooltipRegionName,
      dateRange: animatedDateRange,
      queryClient,
      mode,
    }),
    // The two `data` values look unused because resolveTooltip reads the cache
    // itself; they are here to re-derive when a year arrives. animatedDateRange
    // is memoised on animatedEndDate in Home, so its identity is a safe key —
    // targetDateRange is NOT, which is why it plays no part here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, regionCode, tooltipRegionName, animatedDateRange, queryClient, mode,
     leftResult.data, rightResult.data]
  );

  // Gate on the source, not on what it resolved to: a region whose data hasn't
  // loaded resolves to an em dash, and must still give up the slot like its five
  // siblings rather than showing a date range next to their tooltips.
  if (!source && showDateRange) {
    return <RegionHeaderDateRange dateRange={targetDateRange} />;
  }

  return <CapFacTooltip data={tooltipData} />;
}

export const RegionTooltip = React.memo(RegionTooltipComponent);
