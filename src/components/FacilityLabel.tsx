import React, { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { getFacilityLifecycle } from '@/client/cap-fac-stats';
import { emitTooltip } from '@/client/tooltip-bus';
import { useFleetMode } from '@/client/fleet-mode-context';
import { usePinnableTooltip } from '@/hooks/usePinnableTooltip';
import { useHovercardTrigger } from '@/hooks/useHovercardTrigger';
import { FacilityHovercard } from './FacilityHovercard';

interface FacilityLabelProps {
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  /** The window on screen — the hovercard lists the units visible in it. */
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

  // Says only WHICH facility is being pointed at — the value and the dates are
  // worked out from the window on screen, per region header, so the readout
  // keeps up as the range moves (see RegionTooltip). Emitting unconditionally
  // matters: bailing here when the year wasn't cached used to cancel the pin
  // that raised it.
  const sendTooltipData = (pinned: boolean) => {
    emitTooltip({
      tooltipType: 'period',
      regionCode,
      facilityCode,
      label: facilityName,
      pinned
    });
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
