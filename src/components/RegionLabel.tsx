import React, { useCallback } from 'react';
import { getRegionNames } from '@/client/cap-fac-stats';
import { emitTooltip } from '@/client/tooltip-bus';
import { usePinnableTooltip } from '@/hooks/usePinnableTooltip';

interface RegionLabelProps {
  regionCode: string;
}

/**
 * A region's name heading its group of facilities. Hovering shows the region's
 * average capacity factor over the displayed period; clicking/tapping pins it.
 *
 * The label says only WHICH region is being pointed at — never what it is
 * worth. Each region header works its own number out from the window on screen
 * (see RegionTooltip), so a pinned tooltip keeps up as the range moves instead
 * of freezing at the value it had when the pointer arrived.
 */
export function RegionLabel({ regionCode }: RegionLabelProps) {
  const regionNames = getRegionNames(regionCode);

  const matches = useCallback(
    (data: Record<string, unknown>) =>
      data.regionCode === regionCode && data.tooltipType === 'period' && !data.facilityCode,
    [regionCode]
  );

  const sendTooltipData = (pinned: boolean) => {
    emitTooltip({ tooltipType: 'period', regionCode, pinned });
  };

  const { handlers } = usePinnableTooltip({ matches, sendTooltipData });

  return (
    <div className="opennem-region-label" {...handlers}>
      {regionNames.long}
    </div>
  );
}
