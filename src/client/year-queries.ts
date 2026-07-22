import { queryOptions } from '@tanstack/react-query';
import { FleetMode, GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { CapFacYear, createCapFacYear } from './cap-fac-year';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { getTodayAEST } from '@/shared/date-utils';
import { yearCachePolicy } from '@/shared/config';
import { tileTimingRecorder } from './tile-timing-recorder';

/**
 * Get the earliest year for which data is available.
 */
export function getEarliestYear(): number {
  return getDateBoundaries().earliestDataYear;
}

/**
 * Get the latest year for which data might be available.
 * This is the current year since data is collected in real-time.
 */
export function getLatestYear(): number {
  return getDateBoundaries().latestDataYear;
}

/**
 * Check if a year is within valid bounds.
 */
export function isValidYear(year: number): boolean {
  return year >= getEarliestYear() && year <= getLatestYear();
}

/**
 * The client's single definition of a year of capacity-factor data, one
 * calendar year per query. Note the separation of concerns: the browser NEVER
 * talks to OpenElectricity directly — the queryFn fetches from our own
 * /api/capacity-factors route (which holds the API key and does the heavy
 * lifting), then pre-renders the year into canvas tiles (CapFacYear).
 *
 * TanStack Query supplies the caching, in-flight dedupe by key, retries with
 * exponential backoff, and prefetch support that used to be hand-rolled.
 * Callers are responsible for gating on isValidYear (via `enabled` or an
 * explicit check) — the queryFn does not validate bounds.
 *
 * `mode` is the fleet roster (full vs current); it's part of the query key and
 * the request URL so the two rosters are cached and fetched independently.
 */
export function yearQueryOptions(mode: FleetMode, year: number) {
  return queryOptions({
    queryKey: ['capFacYear', mode, year] as const,
    queryFn: async ({ signal }): Promise<CapFacYear> => {
      // Time the whole fetch + parse + build as `fetch-build` — the latency a
      // user feels per tile. Network overhead ≈ fetch-build − year-build.
      const fetchBuildStart = performance.now();
      const response = await fetch(`/api/capacity-factors?year=${year}&fleet=${mode}`, { signal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: GeneratingUnitCapFacHistoryDTO = await response.json();

      // Tiles are built here, in the queryFn, so the cached value IS the
      // fully-constructed CapFacYear — shared by every observer and readable
      // synchronously via queryClient.getQueryData (see cap-fac-stats).
      const capFacYear = createCapFacYear(year, data);
      tileTimingRecorder.record({
        kind: 'fetch-build',
        year,
        ms: performance.now() - fetchBuildStart,
        at: Date.now(),
      });
      return capFacYear;
    },
    // NEM data is subject to revision (January can revise the December just
    // past), so even past years go stale — on the same tiers the server
    // route uses.
    staleTime: yearCachePolicy(year, getTodayAEST().year).revalidateSeconds * 1000,
    // CapFacYear holds Maps of canvas-bearing class instances; walking them
    // for structural sharing is wasted work and could mix old tiles into new
    // data. The trade-off: a refetch returning identical JSON still yields a
    // fresh CapFacYear, costing each subscribed tile one redraw.
    structuralSharing: false,
  });
}
