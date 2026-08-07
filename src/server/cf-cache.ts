/**
 * The Next.js Data Cache layer for capacity-factor payloads.
 *
 * This is layer 3 of the four described in docs/caching-and-diagnostics.md:
 * browser → Sydney CDN edge → **Data Cache** → OpenElectricity. Everything that
 * wants a year's payload goes through here, so there is exactly one set of
 * `unstable_cache` wrappers in the process.
 *
 * That single-instance property is load-bearing. `unstable_cache` derives its
 * cache key from the wrapper's key parts plus the arguments, so two separately
 * constructed wrappers would write two separate entries. The HTTP route and the
 * cron warmer must therefore share these module-level singletons — which is the
 * whole reason this module exists rather than living inside the route.
 *
 * The warmer calls `getCachedCapacityFactors` DIRECTLY, in-process. It used to
 * warm by self-fetching the public URL, but that request re-enters the Vercel
 * CDN and is served by the edge whenever the edge is warm — so the function
 * never ran and this cache was never touched, leaving entries unread and first
 * in line for eviction. In-process is the only way to guarantee a warm actually
 * reaches the Data Cache.
 */

import { unstable_cache } from 'next/cache';
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { getTodayAEST, getAESTDateTimeString } from '@/shared/date-utils';
import {
  yearCachePolicy,
  YEAR_CACHE_TIERS,
  type YearCachePolicy,
  type YearCacheTier,
} from '@/shared/config';
import type { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';

// Opt-in verbose logging: set DEBUG_OE=1 to trace cache misses locally.
const debug = (...args: unknown[]): void => {
  if (process.env.DEBUG_OE) console.log(...args);
};

// Bump to invalidate every cached CF tile in one deploy-atomic step (it changes
// the unstable_cache key, so all tiers/years recompute on the fixed code with
// fresh facilities metadata). Bumped to v3 for the single-roster change: every
// payload now carries a per-unit `status`, and what used to be the `current`
// roster is derived from it client-side, so entries built under the old
// two-roster scheme must be discarded rather than served stale.
export const CF_CACHE_VERSION = 'v3';

// Per-instance record of genuine cold fetches. `fetchCapacityFactors` (below)
// is the function wrapped by unstable_cache, so it ONLY runs on a Data-Cache
// miss — i.e. a real, rate-limited OpenElectricity fetch. We record each such
// miss so callers can tell whether THIS call paid a cold fetch, by reading
// `coldFetchCount` either side of the await. Module-level ⇒ per-serverless-
// instance and ephemeral: a per-request answer derived from the counter delta
// is authoritative; the historical fields are best-effort.
interface ColdFetchRecord {
  lastColdFetchAt: string;
  lastColdFetchMs: number;
  count: number;
}
const coldFetches = new Map<number, ColdFetchRecord>();

/** How many cold fetches this instance has paid for a year so far. */
export function coldFetchCount(year: number): number {
  return coldFetches.get(year)?.count ?? 0;
}

/** The most recent cold fetch for a year on this instance, if any. */
export function lastColdFetch(year: number): ColdFetchRecord | undefined {
  return coldFetches.get(year);
}

// In-flight upstream fetches, keyed the same way. `unstable_cache` does NOT
// collapse concurrent misses, so without this a visitor and the cron sweep
// landing on the same cold year would each fan out to OpenElectricity for
// identical data — and that matters more now the sweep warms several years at
// once (see warmYears). Entries live only for the duration of the fetch; the
// Data Cache owns the result.
//
// This sits here rather than in CapFacDataService so that it and the cold-fetch
// counter agree: only the caller that actually starts an upstream fetch records
// one. Callers that join it are not cold — they paid nothing — and counting them
// would inflate the `rebuilt` figure the warm-all sweep reports.
const inFlight = new Map<number, Promise<GeneratingUnitCapFacHistoryDTO>>();

async function fetchCapacityFactors(
  year: number,
): Promise<GeneratingUnitCapFacHistoryDTO> {
  const joined = inFlight.get(year);
  if (joined) {
    debug(`🤝 Cache miss - joining in-flight fetch for year ${year}`);
    return joined;
  }

  debug(`🔄 Cache miss - fetching data for year ${year}`);
  const started = performance.now();
  const promise = getCapFacDataService()
    .getCapacityFactors(year)
    .finally(() => {
      inFlight.delete(year);
    });
  inFlight.set(year, promise);

  const result = await promise;
  const prev = coldFetches.get(year);
  coldFetches.set(year, {
    lastColdFetchAt: getAESTDateTimeString(),
    lastColdFetchMs: Math.round(performance.now() - started),
    count: (prev?.count ?? 0) + 1,
  });
  return result;
}

// One unstable_cache wrapper per freshness tier. Revalidate is static per
// wrapper, so the tiers can't share one. Freshness windows live in
// yearCachePolicy — see @/shared/config. A year crossing a tier boundary
// (current→recent at New Year, recent→archive at N-6) changes wrapper and hence
// Data Cache key, costing one cache miss that the next cron warmer run absorbs.
//
// There is one entry per year, not two: the `current` fleet view is derived
// from this payload downstream (@/shared/fleet-filter) rather than fetched and
// cached separately.
//
// Tags are kept so a tier can be busted on demand via revalidateTag() if we
// ever need instant propagation.
const tierCaches = Object.fromEntries(
  (Object.keys(YEAR_CACHE_TIERS) as YearCacheTier[]).map((tier) => [
    tier,
    unstable_cache(
      fetchCapacityFactors,
      ['capacity-factors', CF_CACHE_VERSION, tier],
      {
        revalidate: YEAR_CACHE_TIERS[tier].revalidateSeconds,
        tags: ['capacity-factors', tier],
      },
    ),
  ]),
) as Record<YearCacheTier, typeof fetchCapacityFactors>;

/** The freshness tier a year currently falls in (today, in NEM time). */
export function cachePolicyForYear(year: number): YearCachePolicy {
  return yearCachePolicy(year, getTodayAEST().year);
}

/**
 * Read a year's payload through the Data Cache, fetching from OpenElectricity
 * only on a miss.
 *
 * To find out whether a given call paid that cold fetch, compare
 * `coldFetchCount(year)` either side of the await — the counter only moves when
 * the wrapped function actually ran.
 */
export function getCachedCapacityFactors(
  year: number,
): Promise<GeneratingUnitCapFacHistoryDTO> {
  const { tier } = cachePolicyForYear(year);
  return tierCaches[tier](year);
}
