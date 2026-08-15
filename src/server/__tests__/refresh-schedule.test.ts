/**
 * The write schedule's arithmetic, with no R2 in it.
 *
 * Two properties matter and neither is obvious from reading the code: that a
 * year is rebuilt exactly once per window (never twice, never skipped), and
 * that years of the same tier land on *different* boundaries. The second is the
 * whole point of the change — before it, every year expired in lockstep.
 */
import { describe, expect, it } from 'vitest';
import { parseAbsolute, type ZonedDateTime } from '@internationalized/date';
import { refreshPhaseSeconds, windowsOverdue, yearIsDueAt } from '@/server/refresh-schedule';
import { YEAR_CACHE_TIERS } from '@/shared/config';

const CURRENT = 2026;
const ZONE = 'Australia/Brisbane';

const at = (stamp: string): ZonedDateTime => parseAbsolute(stamp, ZONE);

/** Every instant at which `year` would be rebuilt over `days` from `from`. */
function boundariesWithin(year: number, from: ZonedDateTime, days: number): ZonedDateTime[] {
  const hits: ZonedDateTime[] = [];
  let previous = from;
  // Walk in 10-minute steps, exactly as the cron does.
  for (let step = 1; step <= (days * 24 * 60) / 10; step++) {
    const reference = from.add({ minutes: step * 10 });
    if (yearIsDueAt(year, CURRENT, previous, reference)) {
      hits.push(reference);
      previous = reference;
    }
  }
  return hits;
}

describe('yearIsDueAt', () => {
  it('is due when nothing is stored', () => {
    expect(yearIsDueAt(2010, CURRENT, null, at('2026-08-09T00:00:00+10:00'))).toBe(true);
  });

  it('is not due again within the same slot', () => {
    const builtAt = at('2026-08-09T00:05:00+10:00');
    expect(yearIsDueAt(CURRENT, CURRENT, builtAt, at('2026-08-09T00:55:00+10:00'))).toBe(false);
  });

  // The reason the current tier exists: the DTO nulls today and the future, so
  // the payload only gains a day at Brisbane midnight. A build at 23:30 used to
  // hold until 00:30, leaving the site a day behind for the first half hour.
  it('rebuilds the current year in the first tick after Brisbane midnight', () => {
    const builtAt = at('2026-08-08T23:30:09+10:00');
    expect(yearIsDueAt(CURRENT, CURRENT, builtAt, at('2026-08-08T23:50:00+10:00'))).toBe(false);
    expect(yearIsDueAt(CURRENT, CURRENT, builtAt, at('2026-08-09T00:00:00+10:00'))).toBe(true);
  });

  it('rebuilds the current year once an hour, on the hour', () => {
    const from = at('2026-08-09T00:00:00+10:00');
    const hits = boundariesWithin(CURRENT, from, 1);

    expect(hits).toHaveLength(24);
    for (const hit of hits) expect(hit.minute).toBe(0);
  });

  it('rebuilds a recent year once a day', () => {
    const hits = boundariesWithin(CURRENT - 2, at('2026-08-09T00:00:00+10:00'), 7);
    expect(hits).toHaveLength(7);
  });

  it('rebuilds an archive year once a week', () => {
    const hits = boundariesWithin(CURRENT - 10, at('2026-08-09T00:00:00+10:00'), 28);
    expect(hits).toHaveLength(4);
  });

  // The defect this replaced: dueness measured from the last write meant a cold
  // bucket stamped every year at the same instant and they stayed locked
  // together for good. Observed live — 2006, 2019, 2021 and 2025 were all built
  // within 26 seconds of each other.
  it('spreads years built at the same instant across different boundaries', () => {
    const builtAt = at('2026-08-08T01:40:00+10:00');
    const from = at('2026-08-08T01:40:00+10:00');

    const archive = [CURRENT - 6, CURRENT - 7, CURRENT - 8, CURRENT - 9, CURRENT - 10];
    const firstRebuilds = archive.map((year) => {
      for (let step = 1; step <= (8 * 24 * 60) / 10; step++) {
        const reference = from.add({ minutes: step * 10 });
        if (yearIsDueAt(year, CURRENT, builtAt, reference)) return reference.toDate().getTime();
      }
      throw new Error(`year ${year} never came due`);
    });

    expect(new Set(firstRebuilds).size).toBe(archive.length);
  });

  it('gives every year of a tier its own slot', () => {
    const recent = [2021, 2022, 2023, 2024, 2025];
    const phases = recent.map((year) =>
      refreshPhaseSeconds(year, 'recent', YEAR_CACHE_TIERS.recent.revalidateSeconds),
    );
    // Five consecutive years over five slots is a bijection, so they are spread
    // perfectly evenly — 4.8 hours apart — with no hashing involved.
    expect(new Set(phases).size).toBe(recent.length);
    expect([...phases].sort((a, b) => a - b)).toEqual([0, 17280, 34560, 51840, 69120]);
  });

  it('spreads 23 archive years over seven daily slots, 3 or 4 per day', () => {
    const perSlot = new Map<number, number>();
    for (let year = 1998; year <= 2020; year++) {
      const phase = refreshPhaseSeconds(year, 'archive', YEAR_CACHE_TIERS.archive.revalidateSeconds);
      perSlot.set(phase, (perSlot.get(phase) ?? 0) + 1);
    }
    expect(perSlot.size).toBe(7);
    for (const count of perSlot.values()) expect(count).toBeGreaterThanOrEqual(3);
    for (const count of perSlot.values()) expect(count).toBeLessThanOrEqual(4);
  });

  it('never lets more than one window pass without a rebuild', () => {
    const from = at('2026-01-01T00:00:00+10:00');
    for (const year of [CURRENT, CURRENT - 3, CURRENT - 12]) {
      const hits = boundariesWithin(year, from, 28);
      for (let i = 1; i < hits.length; i++) {
        const gapSeconds =
          (hits[i].toDate().getTime() - hits[i - 1].toDate().getTime()) / 1000;
        expect(gapSeconds).toBeLessThanOrEqual(
          YEAR_CACHE_TIERS[year === CURRENT ? 'current' : year >= CURRENT - 5 ? 'recent' : 'archive']
            .revalidateSeconds,
        );
      }
    }
  });

  it('treats a builtAt in the future as not due, rather than rebuilding forever', () => {
    const builtAt = at('2026-08-10T00:00:00+10:00');
    expect(yearIsDueAt(2010, CURRENT, builtAt, at('2026-08-09T00:00:00+10:00'))).toBe(false);
  });
});

describe('windowsOverdue', () => {
  it('reports 1 at exactly one window old', () => {
    expect(windowsOverdue(CURRENT, CURRENT, 3600)).toBe(1);
    expect(windowsOverdue(CURRENT - 1, CURRENT, 86400)).toBe(1);
    expect(windowsOverdue(CURRENT - 10, CURRENT, 604800)).toBe(1);
  });

  it('scales with the tier, so one threshold covers all three', () => {
    // A day-old archive year is barely overdue; a day-old current year is a
    // sweep that has failed 24 times.
    expect(windowsOverdue(CURRENT - 10, CURRENT, 86400)).toBeLessThan(1);
    expect(windowsOverdue(CURRENT, CURRENT, 86400)).toBe(24);
  });
});
