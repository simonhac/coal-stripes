'use client';

import React, { useCallback } from 'react';
import { CalendarDate } from '@internationalized/date';
import { yearDataVendor, calculateAverageCapacityFactor } from '@/client/year-data-vendor';
import { usePinnableTooltip } from '@/hooks/usePinnableTooltip';

interface FacilityLabelProps {
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  dateRange: { start: CalendarDate; end: CalendarDate };
}

/**
 * A facility's name in the left column. Hovering shows the facility's average
 * capacity factor over the displayed period; clicking/tapping pins it.
 */
export function FacilityLabel({
  facilityCode,
  facilityName,
  regionCode,
  dateRange
}: FacilityLabelProps) {
  const matches = useCallback(
    (data: Record<string, unknown>) =>
      data.facilityCode === facilityCode && data.regionCode === regionCode,
    [facilityCode, regionCode]
  );

  const sendTooltipData = (pinned: boolean) => {
    const stats = yearDataVendor.calculateFacilityStats(regionCode, facilityCode, dateRange);
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
        label: facilityName,
        capacityFactor: avgCapacityFactor,
        tooltipType: 'period' as const,
        regionCode: regionCode,
        facilityCode: facilityCode,
        pinned
      };
      window.dispatchEvent(new CustomEvent('tooltip-data-hover', { detail: tooltipData }));
    }
  };

  const { handlers } = usePinnableTooltip({ matches, sendTooltipData });

  return (
    <div className="opennem-facility-label" {...handlers}>
      {facilityName}
    </div>
  );
}
