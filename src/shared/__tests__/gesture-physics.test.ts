import {
  clamp,
  projectMomentum,
  resolveDragRelease,
  rubberband,
  rubberbandClamp,
  MOMENTUM,
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
