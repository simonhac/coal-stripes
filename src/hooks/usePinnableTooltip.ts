import { useState, useEffect, useRef } from 'react';
import { endTooltip, subscribeTooltip } from '@/client/tooltip-bus';

interface UsePinnableTooltipOptions {
  /** Does a broadcast tooltip belong to this label? Drives the pinned state. */
  matches: (data: Record<string, unknown>) => boolean;
  /** Broadcast this label's tooltip source; `pinned` marks it sticky. */
  sendTooltipData: (pinned: boolean) => void;
}

/**
 * Shared behaviour for the facility and region labels: hovering shows a
 * summary tooltip, clicking (or tapping) pins it open, clicking again unpins.
 *
 * Tooltips are coordinated app-wide over window CustomEvents
 * ('tooltip-data-hover' / 'tooltip-data-hover-end') rather than props, since
 * one global tooltip serves every label and stripe canvas — this hook listens
 * to that bus to know when another tooltip has displaced this one.
 */
export function usePinnableTooltip({ matches, sendTooltipData }: UsePinnableTooltipOptions) {
  const [isPinned, setIsPinned] = useState(false);
  // Touch fires a synthetic click after touchstart; this flag swallows it so a
  // tap doesn't immediately toggle the pin twice.
  const touchHandledRef = useRef(false);

  // Track whether this label's tooltip is the pinned one.
  useEffect(() => subscribeTooltip(
    source => {
      const data = source as unknown as Record<string, unknown>;
      // Another label's tooltip displaces this one, pinned or not.
      setIsPinned(matches(data) ? Boolean(data.pinned) : false);
    },
    () => setIsPinned(false)
  ), [matches]);

  const togglePin = () => {
    if (isPinned) {
      setIsPinned(false); // Update local state immediately
      endTooltip();
    } else {
      setIsPinned(true); // Update local state immediately
      sendTooltipData(true);
    }
  };

  const handleMouseEnter = () => {
    // Don't send hover tooltip if already pinned
    if (!isPinned) {
      sendTooltipData(false);
    }
  };

  const handleMouseLeave = () => {
    // Only send hover-end if not pinned
    if (!isPinned) {
      endTooltip();
    }
  };

  const handleClick = () => {
    // Ignore the synthetic click that follows a handled touch
    if (touchHandledRef.current) {
      touchHandledRef.current = false;
      return;
    }
    togglePin();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    touchHandledRef.current = true;
    togglePin();
  };

  return {
    isPinned,
    /**
     * Pin/unpin directly, for labels that own their own touch handling — see
     * FacilityLabel, which cannot use `handlers.onTouchStart` because it must
     * let a pan through to the gesture bindings underneath.
     */
    togglePin,
    handlers: {
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
      onTouchStart: handleTouchStart,
    },
  };
}
