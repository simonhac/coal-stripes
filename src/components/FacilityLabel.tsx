import React, { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import {
  calculateFacilityStats,
  calculateAverageCapacityFactor,
  getFacilityLifecycle
} from '@/client/cap-fac-stats';
import { useFleetMode } from '@/client/fleet-mode-context';
import { usePinnableTooltip } from '@/hooks/usePinnableTooltip';
import { useHovercardTrigger } from '@/hooks/useHovercardTrigger';
import { FacilityHovercard } from './FacilityHovercard';

interface FacilityLabelProps {
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  dateRange: { start: CalendarDate; end: CalendarDate };
}

/**
 * A facility's name in the left column. Hovering shows the facility's average
 * capacity factor over the displayed period and clicking/tapping pins it;
 * dwelling on the name (or long-pressing it) raises a hovercard linking out to
 * the facility's page on Open Electricity.
 */
export function FacilityLabel({
  facilityCode,
  facilityName,
  regionCode,
  dateRange
}: FacilityLabelProps) {
  const queryClient = useQueryClient();
  const mode = useFleetMode();

  const matches = useCallback(
    (data: Record<string, unknown>) =>
      data.facilityCode === facilityCode && data.regionCode === regionCode,
    [facilityCode, regionCode]
  );

  const sendTooltipData = (pinned: boolean) => {
    const stats = calculateFacilityStats(queryClient, mode, facilityCode, dateRange);
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

  const { togglePin, handlers } = usePinnableTooltip({ matches, sendTooltipData });

  // The trigger owns click and touch: only it can tell a tap from a pan that
  // happened to start over the label. Hover for the tooltip stays on the mouse
  // events below, which is the behaviour every other label shares.
  const { isOpen, anchorRef, cardRef, anchorHandlers, cardHandlers } = useHovercardTrigger({
    onActivate: togglePin
  });

  return (
    <>
      <div
        ref={anchorRef}
        className="opennem-facility-label"
        onMouseEnter={handlers.onMouseEnter}
        onMouseLeave={handlers.onMouseLeave}
        {...anchorHandlers}
      >
        {facilityName}
      </div>
      {isOpen && (
        <FacilityHovercard
          anchor={anchorRef.current}
          cardRef={cardRef}
          facilityCode={facilityCode}
          facilityName={facilityName}
          lifecycle={getFacilityLifecycle(queryClient, mode, facilityCode, dateRange)}
          handlers={cardHandlers}
        />
      )}
    </>
  );
}
