'use client';

import React, { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { calculateRegionStats, calculateAverageCapacityFactor, getRegionNames } from '@/client/cap-fac-stats';
import { useFleetMode } from '@/client/fleet-mode-context';
import { usePinnableTooltip } from '@/hooks/usePinnableTooltip';

interface RegionLabelProps {
  regionCode: string;
  dateRange: { start: CalendarDate; end: CalendarDate };
  isMobile: boolean;
}

/**
 * A region's name heading its group of facilities. Hovering shows the region's
 * average capacity factor over the displayed period; clicking/tapping pins it.
 */
export function RegionLabel({
  regionCode,
  dateRange,
  isMobile
}: RegionLabelProps) {
  const queryClient = useQueryClient();
  const mode = useFleetMode();
  const regionNames = getRegionNames(regionCode);

  const matches = useCallback(
    (data: Record<string, unknown>) =>
      data.regionCode === regionCode && data.tooltipType === 'period' && !data.facilityCode,
    [regionCode]
  );

  const sendTooltipData = (pinned: boolean) => {
    const stats = calculateRegionStats(queryClient, mode, regionCode, dateRange);
    if (!stats) {
      // No data available for this date range - clear tooltip
      window.dispatchEvent(new CustomEvent('tooltip-data-hover-end'));
      return;
    }
    const avgCapacityFactor = calculateAverageCapacityFactor(stats);
    if (avgCapacityFactor !== null) {
      const tooltipData = {
        startDate: dateRange.start,
        endDate: dateRange.end,
        // Use short name for tooltip on mobile
        label: isMobile ? regionNames.short : regionNames.long,
        capacityFactor: avgCapacityFactor,
        tooltipType: 'period' as const,
        regionCode: regionCode,
        pinned
      };
      window.dispatchEvent(new CustomEvent('tooltip-data-hover', { detail: tooltipData }));
    }
  };

  const { handlers } = usePinnableTooltip({ matches, sendTooltipData });

  return (
    <div className="opennem-region-label" {...handlers}>
      {regionNames.long}
    </div>
  );
}
