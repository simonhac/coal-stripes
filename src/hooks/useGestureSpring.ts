import { useRef, useCallback, useEffect } from 'react';
import { Controller } from '@react-spring/web';
import { useDrag, useWheel } from '@use-gesture/react';
import { DATE_BOUNDARIES } from '@/shared/config';
import { resolveDragRelease, rubberbandClamp } from '@/shared/gesture-physics';

interface GestureSpringOptions {
  currentOffset: number; // fractional day-offset from parent (the source of truth; 0 = earliestDataEndDay)
  maxOffset: number; // latestDataDay offset; minOffset is implicitly 0
  onOffsetChange: (offset: number, isDragging: boolean) => void;
}

// ── Tunables ────────────────────────────────────────────────────────────────
// Momentum bounds + projection live in @/shared/gesture-physics (pure, tested).
const SPRING_BACK = { tension: 200, friction: 26 }; // rubber-band snap to bound
const MOMENTUM_SPRING = { tension: 90, friction: 22 }; // coasting glide to a projected target
const NAV_SPRING = { tension: 210, friction: 30 }; // keyboard / month-click glide
const NAV_ANIMATE_MAX_DAYS = 366; // glide programmatic nav up to ~1yr; snap bigger jumps instantly
const WHEEL_SCALE = 1; // day-axis pixels per wheel pixel (tune for trackpad feel)
const RUBBERBAND = 0.15; // @use-gesture resistance coefficient past bounds (drag)
const WHEEL_STRETCH_DAYS = 60; // max elastic overscroll for the wheel, in days

type Phase = 'idle' | 'drag' | 'wheel' | 'spring' | 'navigate';

/**
 * Pure gesture + spring physics for the horizontal day-axis.
 *
 * One persistent react-spring value `x` holds a PIXEL position on the day-axis
 * (`x = dayOffset * pixelsPerDay`). It is not bound to any DOM style — rendering
 * is canvas-reslice, so the spring drives everything through `onOffsetChange`.
 * @use-gesture owns the bounds + rubber-band resistance; react-spring owns the
 * release momentum (decay), snap-back, and keyboard/month glide.
 *
 * Deals only in numeric offsets — no date knowledge.
 */
export function useGestureSpring({
  currentOffset,
  maxOffset,
  onOffsetChange,
}: GestureSpringOptions) {
  const elementRef = useRef<HTMLDivElement>(null);

  // Fresh-per-render mirrors so gesture callbacks never read stale props
  // (repo rule: initialise every gesture from the parent's current offset).
  const currentOffsetRef = useRef(currentOffset);
  const maxOffsetRef = useRef(maxOffset);
  const onOffsetChangeRef = useRef(onOffsetChange);
  currentOffsetRef.current = currentOffset;
  maxOffsetRef.current = maxOffset;
  onOffsetChangeRef.current = onOffsetChange;

  // Per-gesture invariants + bookkeeping
  const ppdRef = useRef(1); // pixels per day, captured at gesture start
  const phaseRef = useRef<Phase>('idle');
  const lastActivePRef = useRef(0); // last active (rubber-banded) px — the true visual release position
  const wheelRawPxRef = useRef(0); // raw (un-clamped) accumulated wheel position (px) within a burst
  const lastEmittedRef = useRef<number | null>(null);
  const lastDraggingRef = useRef(false);
  const settleTargetPxRef = useRef<number | null>(null); // exact final px for a settling animation
  const pendingWheelRef = useRef<{ p: number; dragging: boolean } | null>(null); // latest wheel emit awaiting its frame
  const wheelRafRef = useRef<number | null>(null); // rAF id coalescing the active wheel emits

  const getPixelsPerDay = useCallback(() => {
    const el = elementRef.current;
    if (!el) return ppdRef.current || 1; // before layout: keep last good value
    const width = el.getBoundingClientRect().width;
    return width > 0 ? width / DATE_BOUNDARIES.TILE_WIDTH : ppdRef.current || 1;
  }, []);

  // Emit to the parent: quantise to whole days + dedupe so setEndDate only fires
  // on day-boundary crossings (not every animation frame).
  const emit = useCallback((p: number, dragging: boolean) => {
    const days = Math.round(p / ppdRef.current);
    if (days === lastEmittedRef.current && dragging === lastDraggingRef.current) return;
    lastEmittedRef.current = days;
    lastDraggingRef.current = dragging;
    onOffsetChangeRef.current(days, dragging);
  }, []);

  // Coalesce the high-frequency active-wheel emits to at most one parent update
  // per animation frame. The OS inertial wheel tail fires events faster than
  // React can commit; emitting synchronously on each re-renders the whole tree
  // per event and trips React's max-update-depth guard, freezing the tab.
  // Stashing the latest value and flushing once per rAF caps re-renders at ~60/s
  // while keeping the pan visually smooth. (Drag stays synchronous — pointer
  // moves are already coalesced to ~1/frame by the browser.)
  const scheduleEmit = useCallback((p: number, dragging: boolean) => {
    pendingWheelRef.current = { p, dragging };
    if (wheelRafRef.current !== null) return; // a frame is already queued
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null;
      const pending = pendingWheelRef.current;
      if (!pending) return;
      pendingWheelRef.current = null;
      emit(pending.p, pending.dragging);
    });
  }, [emit]);

  // Drop any queued frame without flushing — call at every phase boundary so a
  // stale wheel value can never land after the gesture/animation has moved on.
  const cancelScheduledEmit = useCallback(() => {
    if (wheelRafRef.current !== null) {
      cancelAnimationFrame(wheelRafRef.current);
      wheelRafRef.current = null;
    }
    pendingWheelRef.current = null;
  }, []);

  // ── One persistent spring holding p (pixels) ────────────────────────────────
  // A standalone Controller (not useSpring) so it's fully imperative and immune
  // to the parent's re-renders. useSpring re-syncs to its initial `{ x: 0 }` on
  // every render, and since emit() re-renders the parent each frame, that would
  // drag the spring to 0 mid-animation. The Controller is created once.
  const apiRef = useRef<Controller<{ x: number }> | null>(null);
  if (!apiRef.current) {
    apiRef.current = new Controller<{ x: number }>({
      x: 0,
      // Only the release/keyboard animations emit here; active drag/wheel emit in
      // their own handlers (crisp, zero-frame latency).
      onChange: (result: { value: { x: number } }) => {
        const phase = phaseRef.current;
        if (phase !== 'spring' && phase !== 'navigate') return;
        emit(result.value.x, false);
      },
      onRest: (result: { finished?: boolean }) => {
        // Ignore interrupted rests (e.g. stop() on a new gesture) so we don't
        // finalise/freeze an animation that's being replaced.
        if (!result.finished) return;
        const phase = phaseRef.current;
        if (phase === 'spring' || phase === 'navigate') {
          // Emit the intended target exactly — the spring can settle a hair short,
          // which would land a boundary snap 1 day off.
          emit(settleTargetPxRef.current ?? apiRef.current!.get().x, false);
          phaseRef.current = 'idle';
        }
      },
    });
  }
  const api = apiRef.current;

  const boundsPx = useCallback(
    () => ({ left: 0, right: maxOffsetRef.current * ppdRef.current }),
    []
  );
  const seedFromCurrent = useCallback((): [number, number] => {
    ppdRef.current = getPixelsPerDay(); // runs before bounds + handler → one ppd for the gesture
    return [currentOffsetRef.current * ppdRef.current, 0];
  }, [getPixelsPerDay]);

  // ── Drag (mouse + touch, via pointer events) ────────────────────────────────
  const dragBind = useDrag(
    ({ first, active, tap, offset: [ox], velocity: [vx], direction: [dx] }) => {
      if (first) {
        phaseRef.current = 'drag';
        api.stop(); // cancel any running decay/spring/navigate before we take over
        cancelScheduledEmit(); // drop any coalesced wheel frame so it can't land mid-drag
      }

      if (active) {
        lastActivePRef.current = ox; // includes rubber-band stretch past bounds
        emit(ox, true); // emit directly during the gesture; the spring is only for release animations
        return;
      }

      // ── Release ──
      if (tap) {
        // A tap (e.g. clicking a month label) — don't move; let the click through.
        // Still land isDragging=false: the pointer-down active emit set it true,
        // and without this a tap strands isDragging=true and disables keyboard
        // nav until the next gesture. The day-quantised dedupe makes it a no-op
        // when no true was emitted (same day, dragging already false).
        emit(lastActivePRef.current, false);
        phaseRef.current = 'idle';
        return;
      }

      // Decide the outcome with the pure, tested physics (all in day-offsets).
      // vx is speed (px/ms, ≥0); dx is the sign — both already in the transformed
      // (day-axis) space. lastActivePRef is the visual, possibly rubber-banded px.
      const ppd = ppdRef.current;
      const result = resolveDragRelease({
        releaseDays: lastActivePRef.current / ppd,
        min: 0,
        max: maxOffsetRef.current,
        speedDaysPerMs: vx / ppd,
        directionSign: dx,
      });

      const targetPx = result.target * ppd;
      // 'settle', or a momentum/snap whose target rounds to the current day, is a
      // no-op: emit directly. A 0-frame spring never fires onRest, which would latch
      // isDragging=true (set by the active-drag emit) and kill keyboard navigation.
      if (result.kind === 'settle' || Math.round(targetPx / ppd) === Math.round(lastActivePRef.current / ppd)) {
        phaseRef.current = 'idle';
        emit(targetPx, false);
      } else {
        // 'snap' (rubber-band back to bound) or 'momentum' (glide to a bounded,
        // clamped projected target). Start fresh from the visual release position
        // (at rest) — the projected target already encodes the throw, so the spring
        // must not carry the flick velocity, or it overshoots to 2006.
        phaseRef.current = 'spring';
        settleTargetPxRef.current = targetPx;
        api.start({
          from: { x: lastActivePRef.current },
          to: { x: targetPx },
          config: result.kind === 'momentum' ? MOMENTUM_SPRING : SPRING_BACK,
        });
      }
    },
    {
      axis: 'x',
      filterTaps: true, // taps still reach tile / month-click handlers
      rubberband: RUBBERBAND, // real resistance past bounds while dragging
      transform: ([x, y]) => [-x, -y], // invert: drag content right ⇒ day-offset decreases
      from: seedFromCurrent,
      bounds: boundsPx,
    }
  );

  // ── Wheel / trackpad (the OS supplies inertia; we just track + settle) ───────
  const wheelBind = useWheel(
    ({ first, last, delta: [dxv] }) => {
      // @use-gesture zeroes the wheel delta if transform/from/bounds are set on
      // useWheel, so we accumulate the raw per-event delta ourselves. Momentum
      // comes for free from the OS inertial wheel stream (a decaying tail).
      if (first) {
        phaseRef.current = 'wheel';
        api.stop();
        cancelScheduledEmit(); // drop any coalesced frame left by a prior gesture
        ppdRef.current = getPixelsPerDay();
        wheelRawPxRef.current = currentOffsetRef.current * ppdRef.current;
      }
      // A delayed trailing wheelEnd can fire ~140ms after the last event — by then a
      // drag or keyboard nav may own the phase; don't let the stale burst clobber it.
      if (phaseRef.current !== 'wheel') return;

      const ppd = ppdRef.current;
      const maxP = maxOffsetRef.current * ppd;
      wheelRawPxRef.current += dxv * WHEEL_SCALE;
      // Elastic resistance past the ends (into the display slop), snapping back on rest.
      const displayPx = rubberbandClamp(wheelRawPxRef.current, 0, maxP, WHEEL_STRETCH_DAYS * ppd);
      lastActivePRef.current = displayPx;

      if (!last) {
        // Active pan: coalesce to ≤1 parent update per frame (the freeze fix).
        scheduleEmit(displayPx, false);
        return;
      }

      // ── End of the wheel burst ── drop the queued frame and land the final
      // resting position (and isDragging=false) synchronously, so keyboard nav
      // re-enables and the window never settles a frame short.
      cancelScheduledEmit();
      emit(displayPx, false);
      if (wheelRawPxRef.current < 0 || wheelRawPxRef.current > maxP) {
        phaseRef.current = 'spring';
        const target = wheelRawPxRef.current < 0 ? 0 : maxP;
        settleTargetPxRef.current = target;
        api.start({ from: { x: displayPx }, to: { x: target }, config: SPRING_BACK });
      } else {
        phaseRef.current = 'idle';
      }
    },
    { axis: 'x' }
  );

  const bind = useCallback(() => ({ ...dragBind(), ...wheelBind() }), [dragBind, wheelBind]);

  // ── Programmatic navigation (keyboard arrows, month clicks) ──────────────────
  // Animates the same spring to an absolute day-offset, anchored on the parent's
  // current offset, emitting non-dragging updates so header + tiles move together.
  const navigateToOffset = useCallback(
    (target: number) => {
      api.stop();
      cancelScheduledEmit(); // a queued wheel frame must not clobber the nav target
      ppdRef.current = getPixelsPerDay();
      const ppd = ppdRef.current;
      const clamped = Math.max(0, Math.min(maxOffsetRef.current, target));
      const from = currentOffsetRef.current;
      // Only glide for short hops (arrow keys, nearby months). A large jump would
      // sweep through years of tiles frame-by-frame and crawl, so snap it instantly.
      const animate = Math.abs(clamped - from) <= NAV_ANIMATE_MAX_DAYS;
      phaseRef.current = 'navigate';
      settleTargetPxRef.current = clamped * ppd;
      api.start({
        from: { x: from * ppd },
        to: { x: clamped * ppd },
        immediate: !animate,
        config: NAV_SPRING,
      });
    },
    [api, getPixelsPerDay, cancelScheduledEmit]
  );

  // Block the browser's back/forward history-swipe on horizontal trackpad/wheel over
  // the viz. (@use-gesture can't preventDefault here without zeroing the wheel delta,
  // so a scoped, non-passive window listener does it instead.)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = elementRef.current;
      if (
        el && e.target instanceof Node && el.contains(e.target) &&
        Math.abs(e.deltaX) > Math.abs(e.deltaY) && e.deltaX !== 0
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // Cancel any queued wheel-emit frame on unmount.
  useEffect(() => cancelScheduledEmit, [cancelScheduledEmit]);

  return { bind, elementRef, navigateToOffset };
}
