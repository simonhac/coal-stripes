/**
 * Turn a tooltip source — what the pointer is on — into the readout one region
 * header shows for it.
 *
 * Every region resolves the same source independently, against ITS OWN region's
 * numbers: hovering a Queensland facility fills the Queensland header with that
 * facility's average and the other five with their own region's, over the same
 * period. That was always true for the other five; doing it for the pointed-at
 * region too is what stops a tooltip freezing at the value it had when the
 * pointer arrived.
 *
 * Pure, and reads the query cache synchronously (never fetches) — so a period
 * whose year hasn't loaded resolves to a null capacity factor, which renders as
 * an em dash until the year lands.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { CalendarDate } from '@internationalized/date';
import type { TooltipData, TooltipSource } from '@/components/CapFacTooltip';
import type { FleetMode } from '@/shared/types';
import {
  calculateAverageCapacityFactor,
  calculateFacilityStats,
  calculateRegionStats,
  getRegionMonthCapacityFactor,
} from './cap-fac-stats';

interface ResolveTooltipArgs {
  /** What is being pointed at, or null when nothing is. */
  source: TooltipSource | null;
  /** The region whose header is asking. */
  regionCode: string;
  /** That region's display name, already picked for the viewport width. */
  regionLabel: string;
  /**
   * The window currently on screen. A `period` source means "the displayed
   * window", so this — not anything carried on the event — decides both the
   * dates shown and the days averaged.
   */
  dateRange: { start: CalendarDate; end: CalendarDate } | null;
  queryClient: QueryClient;
  mode: FleetMode;
}

export function resolveTooltip({
  source,
  regionCode,
  regionLabel,
  dateRange,
  queryClient,
  mode,
}: ResolveTooltipArgs): TooltipData | null {
  if (!source) return null;

  const isOwnRegion = source.regionCode === regionCode;

  if (source.tooltipType === 'period') {
    // getTooltipFormattedDate throws on a period without an endDate, and there
    // is no period to speak of before the timeline has been positioned.
    if (!dateRange) return null;

    // The pointed-at facility gets the facility's own average; everyone else
    // (including this region when a facility elsewhere is pointed at) gets
    // their region's.
    const isOwnFacility = isOwnRegion && !!source.facilityCode;
    const stats = isOwnFacility
      ? calculateFacilityStats(queryClient, mode, source.facilityCode!, dateRange)
      : calculateRegionStats(queryClient, mode, regionCode, dateRange);

    return {
      startDate: dateRange.start,
      endDate: dateRange.end,
      label: isOwnFacility ? (source.label ?? source.facilityCode!) : regionLabel,
      capacityFactor: calculateAverageCapacityFactor(stats),
      tooltipType: 'period',
      regionCode,
      ...(isOwnFacility ? { facilityCode: source.facilityCode } : {}),
      pinned: source.pinned,
    };
  }

  // A day or a month is resolved by the cursor, so the pointed-at region's
  // header shows exactly what the tile reported — down to the unit.
  if (isOwnRegion) return source;

  if (source.tooltipType === 'month') {
    return {
      startDate: source.startDate,
      endDate: null,
      label: regionLabel,
      capacityFactor: getRegionMonthCapacityFactor(
        queryClient,
        mode,
        regionCode,
        source.startDate
      ),
      tooltipType: 'month',
      regionCode,
      pinned: source.pinned,
    };
  }

  // A single day, for this region.
  const stats = calculateRegionStats(queryClient, mode, regionCode, {
    start: source.startDate,
    end: source.startDate,
  });

  return {
    startDate: source.startDate,
    endDate: null,
    label: regionLabel,
    capacityFactor: calculateAverageCapacityFactor(stats),
    tooltipType: 'day',
    regionCode,
    pinned: source.pinned,
  };
}
