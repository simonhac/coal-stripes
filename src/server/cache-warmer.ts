/**
 * Keeping Workers Cache warm.
 *
 * This replaces 420 lines of Vercel warming machinery, and it is short for one
 * reason: there is now a single cache with a single way in. The old warmer had
 * to warm the Data Cache by an in-process call AND the CDN edge by an HTTP
 * self-fetch, because neither reached the other — a split that caused a
 * documented production failure (warming by self-fetch alone silently left the
 * Data Cache to be evicted, because the edge answered and the origin never ran).
 * A loopback through `ctx.exports` warms the one entry that public traffic
 * reads. Verified end to end, including from a cron: .context/spike/RESULTS.md.
 *
 * Why a warmer exists at all, when `docs/cloudflare.md` argued it wouldn't need
 * to: `stale-while-revalidate` is **not honoured** by Workers Cache. A lapsed
 * entry does not serve stale while refreshing — it blocks the next visitor for
 * the full OpenElectricity fetch, 3–9 seconds. Measured on Free and Paid. So the
 * sweep interval must stay comfortably shorter than the shortest tier window
 * (`current`, one hour).
 *
 * Cheap by construction: a warm year is a cache HIT costing a few milliseconds,
 * so a sweep only does real work for entries that actually lapsed.
 */
import { allDataYears } from '@/server/data-years';
import { loopback } from '@/server/loopback';
import { mapPool } from '@/server/map-pool';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';

/** Stop starting new work after this long, so a sweep can't overrun its cron. */
const WARM_BUDGET_MS = 240_000;

/** How many years to warm at once. Matches the stats service's fan-out. */
const WARM_CONCURRENCY = 5;

export interface WarmResult {
  target: string;
  ok: boolean;
  status: number;
  cacheStatus: string | null;
  ms: number;
}

async function warmOne(path: string): Promise<WarmResult> {
  const started = performance.now();
  try {
    const res = await loopback(path);
    // Drain the body, or the subrequest stays open and nothing is stored.
    await res.arrayBuffer();
    return {
      target: path,
      ok: res.ok,
      status: res.status,
      cacheStatus: res.headers.get('cf-cache-status'),
      ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    console.error('warm failed', path, error);
    return {
      target: path,
      ok: false,
      status: 0,
      cacheStatus: null,
      ms: Math.round(performance.now() - started),
    };
  }
}

/**
 * Warm every year plus both stats modes.
 *
 * Stats is warmed on every sweep even though it only rebuilds daily — a warm
 * one is a HIT costing milliseconds, so it self-throttles and there is no need
 * for the separate daily cron the Vercel setup ran.
 */
export async function warmAll(): Promise<{
  warmed: WarmResult[];
  rebuilt: number;
  failed: number;
  totalMs: number;
}> {
  const started = performance.now();
  const paths = [
    ...allDataYears().map(capacityFactorsPath),
    '/api/stats?fleet=full',
    '/api/stats?fleet=current',
  ];

  const warmed = await mapPool(paths, WARM_CONCURRENCY, (path) => {
    if (performance.now() - started > WARM_BUDGET_MS) {
      return Promise.resolve({
        target: path,
        ok: false,
        status: 0,
        cacheStatus: 'SKIPPED',
        ms: 0,
      } satisfies WarmResult);
    }
    return warmOne(path);
  });

  return {
    warmed,
    // Anything that wasn't already a HIT cost a real rebuild — the number worth
    // watching, because it should be near zero in a steady state.
    rebuilt: warmed.filter((w) => w.ok && w.cacheStatus !== 'HIT').length,
    failed: warmed.filter((w) => !w.ok).length,
    totalMs: Math.round(performance.now() - started),
  };
}
