import { QueryClient, queryOptions } from '@tanstack/react-query';
import { FleetMode, GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { CapFacYear, createCapFacYear } from './cap-fac-year';
import { filterFleet } from '@/shared/fleet-filter';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { getTodayAEST } from '@/shared/date-utils';
import { yearCachePolicy } from '@/shared/config';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';
import { CF_DTO_VERSION } from '@/shared/config';
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

/** A year's payload, with its size measured once rather than on every read. */
export interface YearPayload {
  data: GeneratingUnitCapFacHistoryDTO;
  /**
   * Approximate bytes of `data`, for the performance overlay. Taken here
   * because it is the one place the payload is known to be new; the overlay
   * polls on a timer and must not re-stringify ~29 years a tick. It is a proxy:
   * JSON.stringify().length counts UTF-16 code units, not bytes, and ignores
   * in-memory object overhead.
   */
  sizeBytes: number;
}

/**
 * A year's raw payload, straight from our API. One entry per year, shared by
 * both fleet views.
 *
 * Note the separation of concerns: the browser NEVER talks to OpenElectricity
 * directly — this fetches from our own /api/capacity-factors route, which holds
 * the API key and does the heavy lifting.
 *
 * This layer exists so switching fleet mode costs nothing. The server sends one
 * roster (every unit that ever operated, each tagged with `status`) and the
 * `current` view is filtered out of it below, so the toggle re-renders from
 * memory instead of refetching every visible year.
 */
export function yearDataQueryOptions(year: number) {
  return queryOptions({
    queryKey: ['capFacYearData', year, CF_DTO_VERSION] as const,
    queryFn: async ({ signal }): Promise<YearPayload> => {
      const response = await fetch(capacityFactorsPath(year), { signal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      return { data: JSON.parse(text), sizeBytes: text.length };
    },
    // NEM data is subject to revision (January can revise the December just
    // past), so even past years go stale — on the same tiers the server
    // route uses. Held here, on the layer that actually fetches.
    staleTime: yearCachePolicy(year, getTodayAEST().year).revalidateSeconds * 1000,
    // Wider than the client-wide default of 3 (providers.tsx), and capped
    // rather than doubling to 30s: a phone handing over between cells is out
    // for a few seconds, and the default ladder (1s, 2s, 4s) gives up inside
    // that window. Six attempts over ~23s rides out the common blip. Longer
    // outages are the job of failed-year-recovery, which picks up from here.
    retry: 5,
    retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
  });
}

/**
 * The client's single definition of a year of capacity-factor data, as one
 * fleet view sees it: the payload above, filtered to `mode` and pre-rendered
 * into canvas tiles (CapFacYear).
 *
 * TanStack Query supplies the caching, in-flight dedupe by key, retries with
 * exponential backoff, and prefetch support that used to be hand-rolled.
 * Callers are responsible for gating on isValidYear (via `enabled` or an
 * explicit check) — the queryFn does not validate bounds.
 *
 * `mode` stays in the key because the tiles genuinely differ: a facility tile
 * stacks its units vertically, so dropping retired ones changes the canvas.
 * Only the *fetch* is shared, via the base query — which is why this queryFn
 * takes a QueryClient and performs no fetch of its own.
 */
export function yearQueryOptions(queryClient: QueryClient, mode: FleetMode, year: number) {
  return queryOptions({
    queryKey: ['capFacYear', mode, year, CF_DTO_VERSION] as const,
    queryFn: async ({ signal }): Promise<CapFacYear> => {
      // Time the whole fetch + parse + build as `fetch-build` — the latency a
      // user feels per tile. Network overhead ≈ fetch-build − year-build. On a
      // mode switch the base query is already resolved, so this is build-only.
      const fetchBuildStart = performance.now();
      // fetchQuery, NOT ensureQueryData: ensureQueryData returns whatever is
      // cached regardless of age, which would strand this view on a stale
      // payload forever — the revalidation the staleTime below asks for would
      // rebuild the tiles from the same old data. fetchQuery honours the base
      // query's staleTime, so a stale year genuinely refetches; concurrent
      // callers (the two fleet views, adjacent tiles) still share one request.
      const payload = await queryClient.fetchQuery(yearDataQueryOptions(year));

      // Bail before painting if nobody is waiting any more. Panning quickly
      // across cold years would otherwise build — and cache for gcTime — a full
      // set of canvases per year scrolled past, since the payload resolves long
      // after the tile that asked for it has gone. The signal is deliberately
      // NOT passed to the fetch above: that payload is shared, and one view
      // unmounting must not cancel a download the other view still wants.
      if (signal.aborted) throw new Error(`Year ${year} (${mode}) no longer needed`);

      // Tiles are built here, in the queryFn, so the cached value IS the
      // fully-constructed CapFacYear — shared by every observer and readable
      // synchronously via queryClient.getQueryData (see cap-fac-stats).
      const capFacYear = createCapFacYear(year, filterFleet(payload.data, mode));
      tileTimingRecorder.record({
        kind: 'fetch-build',
        year,
        ms: performance.now() - fetchBuildStart,
        at: Date.now(),
      });
      return capFacYear;
    },
    // Matches the base query, so a stale year re-runs the filter+build against
    // a freshly revalidated payload rather than serving tiles built from one.
    staleTime: yearCachePolicy(year, getTodayAEST().year).revalidateSeconds * 1000,
    // The base query owns the network, and the default retry: 3 applies to
    // BOTH layers — so a failing year would be 4 payload attempts, retried 4
    // times by this layer: 16 requests where the user sees one tile. This layer
    // only filters and paints, so it has nothing of its own to retry.
    retry: false,
    // CapFacYear holds Maps of canvas-bearing class instances; walking them
    // for structural sharing is wasted work and could mix old tiles into new
    // data. The trade-off: a refetch returning identical JSON still yields a
    // fresh CapFacYear, costing each subscribed tile one redraw.
    structuralSharing: false,
  });
}
