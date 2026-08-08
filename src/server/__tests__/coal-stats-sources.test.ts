/**
 * The stats payload must state where its data came from and how old it is.
 *
 * /stats is assembled from ~28 per-year payloads, so a stale store and a genuine
 * upstream data gap look identical on the page. The `sources` block is what
 * tells them apart: each year's `builtAt` is the moment that payload was last
 * assembled from OpenElectricity. These tests pin the behaviour that matters —
 * every requested year is accounted for, a year that failed to load is reported
 * as null rather than silently dropped, and the oldest/newest extremes are
 * correct.
 *
 * `computeCoalStats` takes its year reader as a parameter, so these drive it
 * directly rather than stubbing a transport. The aggregation itself is exercised
 * elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { computeCoalStats, type YearReader } from '@/server/coal-stats-service';
import { earliestDataYear, currentDataYear } from '@/server/data-years';
import type { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';

/** A minimal, unit-free payload: enough shape for the provenance path. */
function payload(createdAt: string): GeneratingUnitCapFacHistoryDTO {
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: createdAt,
    data: [],
  };
}

/** Stamp for a year, so each year is distinguishable. */
const stampFor = (year: number): string =>
  `${String(year).padStart(4, '0')}-03-04T05:06:07+10:00`;

/** A reader where `failYears` come back null, as an unbuildable year does. */
function reader(failYears: number[] = []): YearReader {
  return async (year) => (failYears.includes(year) ? null : payload(stampFor(year)));
}

const allYears = (): number[] => {
  const years: number[] = [];
  for (let y = earliestDataYear(); y <= currentDataYear(); y++) years.push(y);
  return years;
};

describe('computeCoalStats — data provenance', () => {
  it('records a builtAt for every year it read', async () => {
    const stats = await computeCoalStats(reader());
    const sources = stats.sources;

    expect(sources).toBeDefined();
    expect(sources!.years.map((s) => s.year)).toEqual(allYears());
    for (const s of sources!.years) {
      expect(s.builtAt).toBe(stampFor(s.year));
    }
  });

  it('reports the oldest and newest payload build times', async () => {
    const sources = (await computeCoalStats(reader())).sources!;

    // stampFor is ordered by year, so the extremes are the range endpoints.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
    expect(sources.newestBuiltAt).toBe(stampFor(currentDataYear()));
  });

  it('marks a year that failed to load as null rather than dropping it', async () => {
    const failed = currentDataYear() - 1;

    const sources = (await computeCoalStats(reader([failed]))).sources!;
    const entry = sources.years.find((s) => s.year === failed);

    expect(entry).toEqual({ year: failed, builtAt: null });
    // A missing year must not become the "oldest" — nulls are excluded.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
  });

  it('reports nulls when no year could be loaded at all', async () => {
    const sources = (await computeCoalStats(reader(allYears()))).sources!;

    expect(sources.oldestBuiltAt).toBeNull();
    expect(sources.newestBuiltAt).toBeNull();
    expect(sources.years.every((s) => s.builtAt === null)).toBe(true);
  });
});
