'use client';

import { useState, useEffect, useRef } from 'react';

interface UsePinnableTooltipOptions {
  /** Does a broadcast tooltip belong to this label? Drives the pinned state. */
  matches: (data: Record<string, unknown>) => boolean;
  /** Build and broadcast this label's tooltip; `pinned` marks it sticky. */
  sendTooltipData: (pinned: boolean) => void;
}

/** Broadcast the shared "tooltip closed" event. */
function endTooltip(): void {
  window.dispatchEvent(new CustomEvent('tooltip-data-hover-end'));
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
  useEffect(() => {
    const handleTooltipUpdate = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data && matches(data)) {
        setIsPinned(data.pinned || false);
      } else if (data) {
        // Another tooltip is active, so this one is not pinned
        setIsPinned(false);
      }
    };

    const handleTooltipEnd = () => setIsPinned(false);

    window.addEventListener('tooltip-data-hover', handleTooltipUpdate);
    window.addEventListener('tooltip-data-hover-end', handleTooltipEnd);
    return () => {
      window.removeEventListener('tooltip-data-hover', handleTooltipUpdate);
      window.removeEventListener('tooltip-data-hover-end', handleTooltipEnd);
    };
  }, [matches]);

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
    handlers: {
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
      onTouchStart: handleTouchStart,
    },
  };
}
