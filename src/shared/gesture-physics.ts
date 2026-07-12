/**
 * Pure, framework-free physics for the horizontal day-axis navigator.
 *
 * These functions contain ALL the decision logic for drag/wheel/keyboard
 * navigation — bounds, momentum projection, snap-back — with no dependency on
 * react-spring, @use-gesture, the DOM, or requestAnimationFrame. That makes the
 * physics deterministic and unit-testable in milliseconds; the React hook
 * (useGestureSpring) is a thin adapter that feeds gesture state in and drives a
 * spring toward the targets these return.
 *
 * Unit convention: everything here is in DAY-OFFSETS (offset 0 = earliest valid
 * end date, `max` = latest). Velocity is in DAYS PER MILLISECOND (signed;
 * negative = toward earlier dates). The hook converts pixels/px-per-ms at the
 * boundary via pxToDays / (vx / pixelsPerDay).
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function pxToDays(px: number, pixelsPerDay: number): number {
  return pixelsPerDay > 0 ? px / pixelsPerDay : 0;
}

export function daysToPx(days: number, pixelsPerDay: number): number {
  return days * pixelsPerDay;
}

/** Momentum / fling tuning (day-offset space). */
export const MOMENTUM = {
  /** A flick coasts as if it kept its release velocity for this long. */
  PROJECTION_MS: 250,
  /**
   * Hard cap on a single flick's throw distance. This is the guardrail that
   * makes momentum robust to however @use-gesture reports velocity: no gesture,
   * however violent, can fling more than this many days — so a flick from the
   * present can never reach the opposite end of a ~19-year range.
   */
  MAX_TRAVEL_DAYS: 550,
  /** Below this |velocity| (days/ms) a release just settles — no momentum. */
  MIN_FLING_VELOCITY: 0.04,
} as const;

/**
 * Where a flick should land: project the release point forward by the release
 * velocity, cap the throw distance, then clamp to the valid range. Bounded by
 * construction — the result is always within [min, max] and never more than
 * MAX_TRAVEL_DAYS from the release point.
 */
export function projectMomentum(
  releaseDays: number,
  velocityDaysPerMs: number,
  min: number,
  max: number,
  projectionMs: number = MOMENTUM.PROJECTION_MS,
  maxTravelDays: number = MOMENTUM.MAX_TRAVEL_DAYS,
): number {
  const rawTravel = velocityDaysPerMs * projectionMs;
  const travel = clamp(rawTravel, -maxTravelDays, maxTravelDays);
  return clamp(releaseDays + travel, min, max);
}

/**
 * Elastic resistance past a bound: a small overshoot passes ~1:1, a large one
 * asymptotes to `maxStretch`. `overshoot` and the result share a unit.
 */
export function rubberband(overshoot: number, maxStretch: number): number {
  const x = Math.abs(overshoot);
  return Math.sign(overshoot) * (x * maxStretch) / (x + maxStretch);
}

/** A position with rubber-band resistance applied past [min, max] (linear within). */
export function rubberbandClamp(pos: number, min: number, max: number, maxStretch: number): number {
  if (pos < min) return min - rubberband(min - pos, maxStretch);
  if (pos > max) return max + rubberband(pos - max, maxStretch);
  return pos;
}

export type ReleaseKind = 'snap' | 'momentum' | 'settle';

export interface ReleaseResult {
  kind: ReleaseKind;
  /** Absolute day-offset target to animate to. Always within [min, max]. */
  target: number;
}

/**
 * Decide what a drag/touch release does, given the visual release position
 * (which may be past a bound if the user was rubber-banding).
 *
 *  - past a bound            → snap back to that bound
 *  - in bounds, fast enough  → momentum to a bounded, clamped target
 *  - otherwise               → settle where released
 */
export function resolveDragRelease(params: {
  releaseDays: number;
  min: number;
  max: number;
  /** |velocity| in days/ms, always >= 0 (this is speed). */
  speedDaysPerMs: number;
  /** direction of motion in offset space: -1, 0, or 1. */
  directionSign: number;
  minFlingVelocity?: number;
}): ReleaseResult {
  const { releaseDays, min, max, speedDaysPerMs, directionSign } = params;
  const minFling = params.minFlingVelocity ?? MOMENTUM.MIN_FLING_VELOCITY;

  if (releaseDays < min || releaseDays > max) {
    return { kind: 'snap', target: releaseDays < min ? min : max };
  }
  if (speedDaysPerMs > minFling && directionSign !== 0) {
    const velocity = speedDaysPerMs * Math.sign(directionSign);
    return { kind: 'momentum', target: projectMomentum(releaseDays, velocity, min, max) };
  }
  return { kind: 'settle', target: clamp(releaseDays, min, max) };
}

/**
 * End of a wheel/trackpad burst: settle the position into bounds. If the burst
 * (incl. the OS inertial tail) rubber-banded past a bound, snap back to it.
 */
export function resolveWheelSettle(
  offsetDays: number,
  min: number,
  max: number,
): { target: number; snapped: boolean } {
  const target = clamp(offsetDays, min, max);
  return { target, snapped: target !== offsetDays };
}
