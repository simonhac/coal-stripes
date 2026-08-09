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
 * negative = toward earlier dates). The hook converts pixels and px-per-ms at
 * the boundary by dividing by its pixels-per-day scale.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Momentum / fling tuning (day-offset space). */
export const MOMENTUM = {
  /** A flick coasts as if it kept its release velocity for this long. */
  PROJECTION_MS: 250,
  /**
   * Hard cap on a single flick's throw distance. This is the guardrail that
   * makes momentum robust to however @use-gesture reports velocity: no gesture,
   * however violent, can fling more than this many days — so a flick from the
   * present can never reach the opposite end of the multi-decade range.
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

/** Programmatic navigation (keyboard arrows, month clicks) tuning, in day-offsets. */
export const NAV = {
  /**
   * A hop longer than this snaps instead of gliding — sweeping years of tiles
   * at 60fps is a strobe, not an animation.
   */
  MAX_GLIDE_DAYS: 366,
} as const;

export interface NavPlan {
  /** false ⇒ jump straight there (immediate, no animation). */
  animate: boolean;
  /** true ⇒ bend the running animation toward the new target, keeping its velocity. */
  retarget: boolean;
}

/**
 * Decide how a programmatic navigation should reach its target.
 *
 * The hop is measured in INTENT space — from the destination the view is
 * already heading to, not from where the stripes have physically got to. A
 * keypress composes on the target (that is the whole point of announcing it
 * synchronously), so judging it against the lagging visual position would count
 * the unspent remainder of the previous hop as part of this one, and a second
 * year-step would blow the glide budget and teleport.
 *
 * When something is already in flight and the hop is glide-sized, the caller
 * must RETARGET the running animation rather than restart it: restarting resets
 * position and velocity, which reads as a hard stop mid-glide.
 */
export function resolveNavigation(params: {
  /** Clamped day-offset asked for. */
  target: number;
  /** Where the stripes are now, in day-offsets. */
  visual: number;
  /** Destination of the running animation, or null when at rest. */
  inFlightTarget: number | null;
  maxGlideDays?: number;
}): NavPlan {
  const { target, visual, inFlightTarget } = params;
  const maxGlide = params.maxGlideDays ?? NAV.MAX_GLIDE_DAYS;
  const anchor = inFlightTarget ?? visual;
  const animate = Math.abs(target - anchor) <= maxGlide;
  return { animate, retarget: animate && inFlightTarget !== null };
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
