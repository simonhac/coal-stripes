import { useCallback, useEffect, useRef, useState } from 'react';

/** How long the pointer must dwell on the label before the card opens. */
const OPEN_DELAY_MS = 400;
/** Grace period after the pointer leaves the label or the card. */
const CLOSE_DELAY_MS = 200;
/** How long a finger must rest on the label to count as a long press. */
const LONG_PRESS_MS = 500;
/**
 * How far a finger may travel and still count as a tap rather than a pan.
 * On mobile the label sits on top of the pannable stripes, so a swipe that
 * happens to start over a name must not activate it.
 */
const TAP_SLOP_PX = 10;

interface UseHovercardTriggerOptions {
  /** Called for a genuine click or tap; a pan over the label never fires it. */
  onActivate: () => void;
}

/**
 * Drives a hovercard from a label, and reconciles the label's own click/tap.
 *
 * Both concerns live here because they share the same pointer bookkeeping: the
 * tap-versus-pan slop test that decides whether to activate is the same test
 * that decides whether a press was long enough to open the card, and the
 * synthetic click browsers emit after a touch has to be swallowed either way.
 *
 * Opens on hover after a delay, or on long press. Stays open while the pointer
 * is over the label or the card, closing after a short grace period once it
 * leaves both.
 */
export function useHovercardTrigger({ onActivate }: UseHovercardTriggerOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const pressTimer = useRef<number | null>(null);

  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  // Touch fires a synthetic click after touchend; this flag swallows it so a
  // tap doesn't activate twice.
  const touchHandled = useRef(false);

  const clearTimer = (timer: React.MutableRefObject<number | null>) => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const close = useCallback(() => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    clearTimer(pressTimer);
    setIsOpen(false);
  }, []);

  const scheduleClose = () => {
    clearTimer(closeTimer);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setIsOpen(false);
    }, CLOSE_DELAY_MS);
  };

  // Drop every pending timer when the row unmounts (facilities come and go as
  // the fleet mode changes).
  useEffect(() => {
    return () => {
      clearTimer(openTimer);
      clearTimer(closeTimer);
      clearTimer(pressTimer);
    };
  }, []);

  // Dismissal paths that only matter while the card is up. The card is
  // positioned from the anchor's viewport rect, so scrolling or resizing closes
  // it rather than letting it drift away from its label.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      close();
    };
    const handleViewportChange = () => close();

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown, true);
    // Capture, so scrolling an inner container counts too.
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange);
    };
  }, [isOpen, close]);

  const handlePointerEnter = (e: React.PointerEvent) => {
    // Touch gets the card via long press; a tap must not arm the hover timer.
    if (e.pointerType === 'touch') return;
    clearTimer(closeTimer);
    if (isOpen || openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      setIsOpen(true);
    }, OPEN_DELAY_MS);
  };

  const handlePointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    clearTimer(openTimer);
    scheduleClose();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    // Deliberately not stopping propagation: the touch must still reach the
    // @use-gesture bindings on the viz container so panning keeps working.
    const touch = e.touches[0];
    touchOrigin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    dragged.current = false;
    clearTimer(pressTimer);
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      setIsOpen(true);
    }, LONG_PRESS_MS);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const origin = touchOrigin.current;
    const touch = e.touches[0];
    if (!origin || !touch) return;
    if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > TAP_SLOP_PX) {
      dragged.current = true;
      clearTimer(pressTimer);
    }
  };

  const handleTouchEnd = () => {
    clearTimer(pressTimer);
    touchHandled.current = true;
    if (!dragged.current) onActivate();
    dragged.current = false;
  };

  const handleTouchCancel = () => {
    clearTimer(pressTimer);
    dragged.current = false;
  };

  const handleClick = () => {
    // Ignore the synthetic click that follows a handled touch.
    if (touchHandled.current) {
      touchHandled.current = false;
      return;
    }
    onActivate();
  };

  return {
    isOpen,
    close,
    /** Attach to the label; also the element the card is positioned against. */
    anchorRef,
    /** Attach to the card's root element. */
    cardRef,
    anchorHandlers: {
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
      onClick: handleClick,
    },
    cardHandlers: {
      onPointerEnter: () => clearTimer(closeTimer),
      onPointerLeave: scheduleClose,
    },
  };
}
