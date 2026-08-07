/**
 * The stats payload must state where its data came from and how old it is.
 *
 * /stats is assembled from ~28 independently-cached per-year payloads, so a
 * stale cache and a genuine upstream data gap look identical on the page. The
 * `sources` block is what tells them apart: each year's `builtAt` is the moment
 * that payload was last assembled from OpenElectricity. These tests pin the
 * behaviour that matters — every requested year is accounted for, a year that
 * failed to load is reported as null rather than silently dropped, and the
 * oldest/newest extremes are correct.
 *
 * `computeCoalStats` reads each year back through Workers Cache via a loopback
 * into our own entrypoint; the Jest mock for `cloudflare:workers` forwards that
 * to global fetch, which is what these tests stub. The aggregation itself is
 * exercised elsewhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { computeCoalStats } from '@/server/coal-stats-service';
import { earliestDataYear, currentDataYear } from '@/server/data-years';
import type { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';

/** A minimal, unit-free payload: enough shape for the fetch/provenance path. */
function payload(createdAt: string): GeneratingUnitCapFacHistoryDTO {
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: createdAt,
    data: [],
  };
}

/** Stamp for a year, so each mocked year is distinguishable. */
const stampFor = (year: number): string =>
  `${String(year).padStart(4, '0')}-03-04T05:06:07+10:00`;

/**
 * Mock the per-year self-fetch. `failYears` return a non-ok response, which
 * fetchYear maps to null.
 */
function mockFetch(failYears: number[] = []): Mock {
  const fn = vi.fn(async (url: string) => {
    const year = Number.parseInt(new URL(url).searchParams.get('year') ?? '', 10);
    // arrayBuffer: the loopback drains a failed response before discarding it,
    // so the subrequest doesn't stay open.
    if (failYears.includes(year)) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload(stampFor(year)),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('computeCoalStats — data provenance', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('records a builtAt for every year it fetched', async () => {
    mockFetch();

    const stats = await computeCoalStats('full');
    const sources = stats.sources;

    const expectedYears: number[] = [];
    for (let y = earliestDataYear(); y <= currentDataYear(); y++) expectedYears.push(y);

    expect(sources).toBeDefined();
    expect(sources!.years.map((s) => s.year)).toEqual(expectedYears);
    for (const s of sources!.years) {
      expect(s.builtAt).toBe(stampFor(s.year));
    }
  });

  it('reports the oldest and newest payload build times', async () => {
    mockFetch();

    const sources = (await computeCoalStats('full')).sources!;

    // stampFor is ordered by year, so the extremes are the range endpoints.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
    expect(sources.newestBuiltAt).toBe(stampFor(currentDataYear()));
  });

  it('marks a year that failed to load as null rather than dropping it', async () => {
    const failed = currentDataYear() - 1;
    mockFetch([failed]);

    const sources = (await computeCoalStats('full')).sources!;
    const entry = sources.years.find((s) => s.year === failed);

    expect(entry).toEqual({ year: failed, builtAt: null });
    // A missing year must not become the "oldest" — nulls are excluded.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
  });

  it('reports nulls when no year could be loaded at all', async () => {
    const allYears: number[] = [];
    for (let y = earliestDataYear(); y <= currentDataYear(); y++) allYears.push(y);
    mockFetch(allYears);

    const sources = (await computeCoalStats('full')).sources!;

    expect(sources.oldestBuiltAt).toBeNull();
    expect(sources.newestBuiltAt).toBeNull();
    expect(sources.years.every((s) => s.builtAt === null)).toBe(true);
  });
});
