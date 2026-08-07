'use client';

import React, { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { calculateFacilityStats, calculateAverageCapacityFactor } from '@/client/cap-fac-stats';
import { useFleetMode } from '@/client/fleet-mode-context';
import { facilityUrl } from '@/shared/openelectricity-links';

interface FacilityLabelProps {
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  dateRange: { start: CalendarDate; end: CalendarDate };
}

/**
 * How far a finger may travel and still count as a tap rather than a pan.
 * On mobile the label sits on top of the pannable stripes, so a swipe that
 * happens to start over a name must not follow the link.
 */
const TAP_SLOP_PX = 10;

/**
 * A facility's name in the left column, linking out to the facility's page on
 * Open Electricity. Hovering shows the facility's average capacity factor over
 * the displayed period.
 */
export function FacilityLabel({
  facilityCode,
  facilityName,
  regionCode,
  dateRange
}: FacilityLabelProps) {
  const queryClient = useQueryClient();
  const mode = useFleetMode();

  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const sendTooltipData = () => {
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
        pinned: false
      };
      window.dispatchEvent(new CustomEvent('tooltip-data-hover', { detail: tooltipData }));
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    // Deliberately not stopping propagation: the touch must still reach the
    // @use-gesture bindings on the viz container so panning keeps working.
    const touch = e.touches[0];
    touchOrigin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    dragged.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const origin = touchOrigin.current;
    const touch = e.touches[0];
    if (!origin || !touch) return;
    if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_SLOP_PX) {
      dragged.current = true;
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // Swallow the synthetic click that follows a pan gesture over the label.
    if (dragged.current) {
      dragged.current = false;
      e.preventDefault();
    }
  };

  return (
    <a
      className="opennem-facility-label"
      href={facilityUrl(facilityCode)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${facilityName} — open on Open Electricity in a new tab`}
      // Anchors are natively draggable; without this a pan that starts on a
      // label becomes a link drag-and-drop and never reaches @use-gesture.
      draggable={false}
      onMouseEnter={sendTooltipData}
      onMouseLeave={() => window.dispatchEvent(new CustomEvent('tooltip-data-hover-end'))}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onClick={handleClick}
    >
      {facilityName}
    </a>
  );
}
