import {
  clamp,
  projectMomentum,
  resolveDragRelease,
  rubberband,
  rubberbandClamp,
  resolveNavigation,
  MOMENTUM,
  NAV,
} from '../gesture-physics';

// A realistic range: ~19 years of daily offsets (2006-01-01 .. present).
const MIN = 0;
const MAX = 7132;

describe('gesture-physics: clamp', () => {
  it('clamps to bounds', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe('gesture-physics: projectMomentum', () => {
  it('throws forward with a positive velocity', () => {
    const t = projectMomentum(1000, 1, MIN, MAX); // 1 day/ms
    expect(t).toBeGreaterThan(1000);
    expect(t).toBeLessThanOrEqual(1000 + MOMENTUM.MAX_TRAVEL_DAYS);
  });

  it('throws backward with a negative velocity', () => {
    const t = projectMomentum(1000, -1, MIN, MAX);
    expect(t).toBeLessThan(1000);
  });

  it('NEVER travels more than MAX_TRAVEL_DAYS, however violent the flick', () => {
    for (const v of [5, 20, 50, 500, 5000]) {
      const fwd = projectMomentum(3000, v, MIN, MAX);
      const back = projectMomentum(3000, -v, MIN, MAX);
      expect(Math.abs(fwd - 3000)).toBeLessThanOrEqual(MOMENTUM.MAX_TRAVEL_DAYS + 1e-9);
      expect(Math.abs(back - 3000)).toBeLessThanOrEqual(MOMENTUM.MAX_TRAVEL_DAYS + 1e-9);
    }
  });

  it('always lands within [min, max]', () => {
    for (const release of [0, 100, 3500, MAX - 100, MAX]) {
      for (const v of [-5000, -50, -1, 0, 1, 50, 5000]) {
        const t = projectMomentum(release, v, MIN, MAX);
        expect(t).toBeGreaterThanOrEqual(MIN);
        expect(t).toBeLessThanOrEqual(MAX);
      }
    }
  });

  it('is monotonic in velocity', () => {
    const a = projectMomentum(3000, 0.5, MIN, MAX);
    const b = projectMomentum(3000, 1.0, MIN, MAX);
    const c = projectMomentum(3000, 2.0, MIN, MAX);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });
});

describe('gesture-physics: resolveDragRelease', () => {
  it('snaps back to max when released past the right/present bound (overscroll)', () => {
    const r = resolveDragRelease({
      releaseDays: MAX + 60, // rubber-banded past present
      min: MIN,
      max: MAX,
      speedDaysPerMs: 0,
      directionSign: 0,
    });
    expect(r.kind).toBe('snap');
    expect(r.target).toBe(MAX);
  });

  it('snaps back to min when released past the left/start bound', () => {
    const r = resolveDragRelease({
      releaseDays: -60,
      min: MIN,
      max: MAX,
      speedDaysPerMs: 0,
      directionSign: 0,
    });
    expect(r.kind).toBe('snap');
    expect(r.target).toBe(MIN);
  });

  it('overscroll release snaps to the SAME bound even with residual velocity', () => {
    // A fast release while stretched past present must still snap to present,
    // never fling to the far end.
    const r = resolveDragRelease({
      releaseDays: MAX + 40,
      min: MIN,
      max: MAX,
      speedDaysPerMs: 5,
      directionSign: 1,
    });
    expect(r.kind).toBe('snap');
    expect(r.target).toBe(MAX);
  });

  // ── REGRESSION: "pulled back the rubber band from the present day, it
  //    zoomed back to 1 Jan 2006" — a hard backward flick from the present must
  //    NOT fling to offset 0 (the opposite end of a ~19-year range). ──
  it('a hard backward flick from the present stays near the present (never 2006)', () => {
    const r = resolveDragRelease({
      releaseDays: MAX, // at the present day
      min: MIN,
      max: MAX,
      speedDaysPerMs: 50, // an aggressive flick (whatever @use-gesture reports)
      directionSign: -1, // toward earlier dates
    });
    expect(r.kind).toBe('momentum');
    expect(r.target).not.toBe(MIN); // NOT offset 0 / 1 Jan 2006
    expect(r.target).toBeGreaterThanOrEqual(MAX - MOMENTUM.MAX_TRAVEL_DAYS);
    expect(r.target).toBeLessThanOrEqual(MAX);
  });

  it('a normal in-bounds flick produces bounded momentum', () => {
    const r = resolveDragRelease({
      releaseDays: 3000,
      min: MIN,
      max: MAX,
      speedDaysPerMs: 1,
      directionSign: -1,
    });
    expect(r.kind).toBe('momentum');
    expect(r.target).toBeLessThan(3000);
    expect(3000 - r.target).toBeLessThanOrEqual(MOMENTUM.MAX_TRAVEL_DAYS);
  });

  it('settles in place on a slow release', () => {
    const r = resolveDragRelease({
      releaseDays: 3000,
      min: MIN,
      max: MAX,
      speedDaysPerMs: 0.01, // below MIN_FLING_VELOCITY
      directionSign: -1,
    });
    expect(r.kind).toBe('settle');
    expect(r.target).toBe(3000);
  });

  it('momentum toward a bound clamps to that bound (no overshoot)', () => {
    const r = resolveDragRelease({
      releaseDays: MAX - 20, // near the present
      min: MIN,
      max: MAX,
      speedDaysPerMs: 50, // hard flick forward, would overshoot present
      directionSign: 1,
    });
    expect(r.kind).toBe('momentum');
    expect(r.target).toBe(MAX);
  });
});

describe('gesture-physics: resolveNavigation', () => {
  // A ⌘arrow year-boundary hop: TILE_WIDTH is 365, so one press moves ~a year.
  const YEAR = 365;

  it('at rest, a short hop glides from where the stripes are', () => {
    expect(resolveNavigation({ target: 5000, visual: 5030, inFlightTarget: null }))
      .toEqual({ animate: true, retarget: false });
  });

  it('at rest, a hop right on the cap still glides', () => {
    expect(resolveNavigation({ target: 5000, visual: 5000 + NAV.MAX_GLIDE_DAYS, inFlightTarget: null }))
      .toEqual({ animate: true, retarget: false });
  });

  it('at rest, a multi-year jump snaps rather than sweeping the tiles', () => {
    // `s` (jump to start) from the present.
    expect(resolveNavigation({ target: MIN, visual: MAX, inFlightTarget: null }))
      .toEqual({ animate: false, retarget: false });
  });

  // The regression: a second ⌘arrow while the first is still gliding. Measured
  // from the lagging visual position the distance is ~1.5 years and the nav used
  // to teleport; measured in intent space it is one ordinary year hop.
  it('mid-glide, a second year hop retargets instead of snapping', () => {
    const plan = resolveNavigation({
      target: 5000 - YEAR, // where the second press is headed
      visual: 5000 + 180, // the first glide is only halfway there
      inFlightTarget: 5000, // ...but this is where it was already going
    });
    expect(plan).toEqual({ animate: true, retarget: true });
    // Sanity: the same numbers judged against the visual position would not glide.
    expect(Math.abs(5000 - YEAR - (5000 + 180))).toBeGreaterThan(NAV.MAX_GLIDE_DAYS);
  });

  it('mid-glide, chained hops keep retargeting however far the view falls behind', () => {
    let inFlightTarget = 5000;
    for (let i = 0; i < 5; i++) {
      const target = inFlightTarget - YEAR;
      expect(resolveNavigation({ target, visual: 5000, inFlightTarget }))
        .toEqual({ animate: true, retarget: true });
      inFlightTarget = target;
    }
  });

  it('mid-glide, a jump too long to glide still snaps', () => {
    expect(resolveNavigation({ target: MIN, visual: MAX - 100, inFlightTarget: MAX - YEAR }))
      .toEqual({ animate: false, retarget: false });
  });

  it('honours an overridden cap', () => {
    expect(resolveNavigation({ target: 100, visual: 0, inFlightTarget: null, maxGlideDays: 50 }))
      .toEqual({ animate: false, retarget: false });
    expect(resolveNavigation({ target: 40, visual: 0, inFlightTarget: null, maxGlideDays: 50 }))
      .toEqual({ animate: true, retarget: false });
  });
});

describe('gesture-physics: rubberband', () => {
  it('is 0 at the bound and grows sub-linearly (resisted)', () => {
    expect(rubberband(0, 90)).toBe(0);
    expect(rubberband(10, 90)).toBeGreaterThan(0);
    expect(rubberband(10, 90)).toBeLessThan(10);
  });
  it('asymptotes to maxStretch for large overshoot, both directions', () => {
    expect(rubberband(1e7, 90)).toBeLessThan(90);
    expect(rubberband(1e7, 90)).toBeGreaterThan(89);
    expect(rubberband(-1e7, 90)).toBeGreaterThan(-90);
    expect(rubberband(-1e7, 90)).toBeLessThan(-89);
  });
  it('rubberbandClamp: linear within bounds, resisted past them, never beyond ±maxStretch', () => {
    expect(rubberbandClamp(50, 0, 100, 90)).toBe(50);
    const below = rubberbandClamp(-500, 0, 100, 90);
    expect(below).toBeLessThan(0);
    expect(below).toBeGreaterThan(-90); // never further than maxStretch past the bound
    const above = rubberbandClamp(600, 0, 100, 90);
    expect(above).toBeGreaterThan(100);
    expect(above).toBeLessThan(100 + 90);
  });
});
