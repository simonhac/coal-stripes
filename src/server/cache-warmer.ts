/**
 * Cache warming for the capacity-factors API.
 *
 * The owner never wants a visitor to wait on OpenElectricity. Two layers stand
 * between them and that ~5 s fetch (see docs/caching-and-diagnostics.md):
 *
 *   - the **Vercel CDN edge** in the visitor's own region — the fast one, and
 *     the only one that answers without the function running at all;
 *   - the **Next.js Data Cache** at the origin, which the function reads when
 *     the edge has nothing.
 *
 * Both are populated by whoever makes the first request after an entry goes
 * missing. This module makes that "first request" a scheduled cron rather than
 * an unlucky user, and it warms the two layers by different means because they
 * respond to different things:
 *
 *   1. an **in-process** call into the Data Cache (`getCachedCapacityFactors`),
 *      which is the only way to guarantee that layer is touched. Warming it by
 *      self-fetching the public URL — as this module used to — silently fails
 *      whenever the edge already holds a copy: the CDN answers, the function
 *      never runs, and the Data Cache entry is left unread and first in line
 *      for eviction. `cache: 'no-store'` does not prevent that; it disables
 *      Next's fetch cache, not Vercel's CDN.
 *   2. a plain **HTTP self-fetch** afterwards, which re-enters the CDN and
 *      keeps the edge entry from ageing out. Note this only ever warms the edge
 *      in the *function's own region* — which is exactly why `vercel.json` pins
 *      the functions to `syd1`, where the users are.
 */

import { getTodayAEST } from '@/shared/date-utils';
import {
  DATE_BOUNDARIES,
  yearCachePolicy,
  type YearCacheTier,
} from '@/shared/config';
import {
  cachePolicyForYear,
  coldFetchCount,
  getCachedCapacityFactors,
} from '@/server/cf-cache';
import { mapPool } from '@/server/map-pool';
import { QUEUE_PRIORITY, withQueuePriority } from '@/server/queued-oeclient';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';

/** Bearer-token check that fails closed when no secret is configured. */
function matchesBearer(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * Verify a request came from Vercel Cron (or another authorised caller).
 *
 * When the `CRON_SECRET` environment variable is set, Vercel automatically
 * attaches `Authorization: Bearer <CRON_SECRET>` to cron invocations. We fail
 * closed: if no secret is configured, no caller is authorised.
 */
export function isAuthorisedCronRequest(request: Request): boolean {
  return matchesBearer(request, process.env.CRON_SECRET);
}

/**
 * Verify a request is authorised to purge the caches.
 *
 * Deliberately a different secret from `CRON_SECRET`: the cron token is
 * machine-only and never leaves Vercel, while this one gets typed by hand into
 * the field on /diagnostics. Keeping them separate means the convenient one
 * can't be used to impersonate cron, and either can be rotated alone. Same
 * fail-closed rule — if `CACHE_SECRET` is unset, nobody is authorised.
 */
export function isAuthorisedPurgeRequest(request: Request): boolean {
  return matchesBearer(request, process.env.CACHE_SECRET);
}

/** The base URL of the current deployment, for internal self-fetches. */
export function getBaseUrl(): string {
  // Production uses the stable project domain; previews use the deployment URL.
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (host) return `https://${host}`;
  // Local development.
  return `http://localhost:${process.env.PORT ?? '3000'}`;
}

/**
 * How many years a sweep works on at once.
 *
 * Each year is two OpenElectricity requests (NEM + WEM, already parallel), so 4
 * years means 8 in flight — under the client queue's ceiling of 10, and its
 * 100 ms pacer staggers their starts. Measured, OpenElectricity never rate-
 * limits us (zero 429s at 4, 8 and 12 concurrent full-year queries) but their
 * cold throughput saturates around one heavy request per second: 4 → 12
 * concurrent multiplied median latency by 2.2× and bought almost no extra
 * throughput. So this is where the curve flattens; going wider would only make
 * a visitor's concurrent cold fetch slower.
 */
export const WARM_CONCURRENCY = 4;

export interface WarmResult {
  year: number;
  ok: boolean;
  status: number;
  ms: number;
  /**
   * Did this warm have to rebuild the entry from OpenElectricity? In steady
   * state every sweep should report all-false; a non-zero count is the Data
   * Cache having evicted entries between sweeps, which is otherwise invisible.
   */
  cold: boolean;
  /** Not attempted, because the sweep ran out of time. See `deadline`. */
  skipped: boolean;
}

export interface WarmOptions {
  /**
   * A `performance.now()` timestamp after which no further years are started.
   *
   * A fully-cold sweep is the slow case — every year is a real upstream fetch —
   * and it has to fit inside the function's `maxDuration` or the platform kills
   * it mid-flight, wasting the work already done. Stopping early instead turns
   * that into a clean partial result plus a log line. It self-heals: the years
   * that did get warmed are cheap next time, so each sweep reaches further than
   * the last.
   */
  deadline?: number;
}

/**
 * Should this sweep spend a round-trip keeping the edge copy of a year alive?
 *
 * Not every year, every sweep. A full payload is ~230 KB, so refreshing all ~28
 * year entries every 10 minutes moves ~6.5 MB a sweep — around 28 GB a month —
 * to keep entries alive that already have a 7-day edge lifetime. With the origin
 * in Sydney an edge miss now costs a visitor one local round-trip rather than a
 * cold fetch, so that is a poor trade for the archive.
 *
 * So we refresh the edge for:
 *   - `current` and `recent` years, which is where visitors actually land (the
 *     app opens on the current year), and whose edge lifetimes are short enough
 *     to lapse between sweeps anyway; and
 *   - any year we just rebuilt, whose edge copy is now stale by definition.
 *
 * Archive years otherwise rely on the Data Cache — which this sweep guarantees
 * is warm — plus real traffic to populate the edge.
 */
function shouldRefreshEdge(year: number, rebuilt: boolean): boolean {
  return rebuilt || cachePolicyForYear(year).tier !== 'archive';
}

/**
 * Best-effort refresh of the CDN edge entry for a year.
 *
 * Runs after the Data Cache is known-warm, so on an edge MISS the origin
 * answers from cache in milliseconds. Failures are swallowed: locally there is
 * no CDN at all, and a missed edge refresh costs a visitor one origin
 * round-trip, not a cold fetch.
 *
 * Uses capacityFactorsPath so this warms the exact URL a browser asks for. The
 * CDN keys on the whole query string, so requesting anything else — as this did
 * before, omitting the build id the client has sent since the per-deploy cache
 * bust — warms an entry no visitor ever reads.
 */
async function refreshEdge(baseUrl: string, year: number): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}${capacityFactorsPath(year)}`, {
      headers: { 'user-agent': 'coal-stripes-cache-warmer' },
      cache: 'no-store',
    });
    // Drain the body so the connection is released and the edge sees a
    // completed response worth storing.
    await res.arrayBuffer();
  } catch {
    // Ignored on purpose — see the doc comment.
  }
}

/**
 * Warm both cache layers for the given years.
 *
 * One pass covers both fleet views: the server holds a single roster per year
 * and `current` is derived from it in the browser, so there is nothing
 * mode-specific left to warm. Upstream requests are queued at background
 * priority, so a visitor who lands on a cold year mid-sweep jumps ahead of the
 * sweep's remaining work rather than queueing behind it.
 */
export async function warmYears(
  years: number[],
  options: WarmOptions = {},
): Promise<WarmResult[]> {
  const baseUrl = getBaseUrl();

  return mapPool(years, WARM_CONCURRENCY, async (year) => {
    const started = performance.now();
    if (options.deadline !== undefined && started > options.deadline) {
      return { year, ok: false, status: 0, ms: 0, cold: false, skipped: true };
    }
    try {
      const coldBefore = coldFetchCount(year);
      await withQueuePriority(QUEUE_PRIORITY.background, () =>
        getCachedCapacityFactors(year),
      );
      const cold = coldFetchCount(year) > coldBefore;
      if (shouldRefreshEdge(year, cold)) await refreshEdge(baseUrl, year);
      return {
        year,
        ok: true,
        status: 200,
        ms: Math.round(performance.now() - started),
        cold,
        skipped: false,
      };
    } catch (error) {
      // Loud on purpose. A sweep that silently returns all-failed looks
      // identical to one that had nothing to do, and the whole point of this
      // module is knowing which.
      console.error(
        `warm-all: ${year} failed:`,
        error instanceof Error ? error.stack ?? error.message : error,
      );
      return {
        year,
        ok: false,
        status: 0,
        ms: Math.round(performance.now() - started),
        cold: false,
        skipped: false,
      };
    }
  });
}

/**
 * Diagnostics: probe (rather than warm) the cache for a set of years.
 *
 * `warmYears` above only needs to know whether the warm succeeded; the
 * diagnostics endpoint wants to know the state of each layer separately, so
 * "is the cache doing its job?" becomes a reproducible check. This is a
 * read-only sibling — it does not mutate the lean `WarmResult` shape the crons
 * depend on.
 *
 * Each year is probed TWICE, in this order:
 *
 *   1. a **cache-busted** fetch (`&probe=…`, a param the route ignores). No
 *      edge entry exists for that URL, so the request always reaches the
 *      function and its `x-cf-cold` / `x-cf-built-at` headers describe the Data
 *      Cache honestly. This runs first on purpose: a plain fetch that missed
 *      the edge would warm the Data Cache and hide the very thing we're asking
 *      about.
 *   2. a **plain** fetch of the real URL, which reports the edge state
 *      (`x-vercel-cache`, `age`) as a visitor would experience it.
 *
 * The classification comes from (1) alone. The old single-probe version trusted
 * an edge HIT first and reported `warm` on it — which meant a year could read
 * warm while the Data Cache behind it was empty, and that is precisely the
 * state that produces a surprise cold fetch once the edge entry expires.
 */

// Latency bands (ms), used only where there is no CDN and no marker header
// (i.e. local dev). ~700ms is a warm Data-Cache hit even on an edge MISS; a
// cold OpenElectricity fetch (rate-limited, retried, 2-network fan-out) is
// multi-second.
export const PROBE_WARM_MAX_MS = 1500;
export const PROBE_COLD_MIN_MS = 3000;

export type TileClassification = 'warm' | 'cold' | 'uncertain';

/** What the visitor-facing CDN edge did with the real URL. */
export interface ProbeEdge {
  xVercelCache: string | null; // HIT | MISS | STALE | PRERENDER | null (no CDN, e.g. local dev)
  age: number | null; // CDN Age header, seconds
  ms: number;
}

/** What the origin's Data Cache did, measured with the edge bypassed. */
export interface ProbeDataCache {
  coldFetch: boolean | null; // from x-cf-cold; null when the header is absent
  coldFetchMs: number | null; // from x-cf-cold-ms
  // From x-cf-built-at: when this year's payload was last assembled from
  // OpenElectricity. Unlike the cache signals it is a property of the BODY, so
  // it answers "how old is the data?" rather than "who served it?".
  builtAt: string | null;
  ms: number;
}

export interface ProbeResult {
  year: number;
  tier: YearCacheTier;
  ms: number; // both probes combined
  status: number;
  ok: boolean;
  edge: ProbeEdge;
  dataCache: ProbeDataCache;
  classification: TileClassification;
}

function classifyProbe(
  ok: boolean,
  ms: number,
  coldFetch: boolean | null,
): TileClassification {
  if (!ok) return 'uncertain';
  // The function ran (the probe bypasses the edge) and told us definitively.
  if (coldFetch === true) return 'cold';
  if (coldFetch === false) return 'warm';
  // Latency fallback: no marker header, e.g. an older deployment.
  if (ms <= PROBE_WARM_MAX_MS) return 'warm';
  if (ms >= PROBE_COLD_MIN_MS) return 'cold';
  return 'uncertain';
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// Monotonic, so no two probes in a process share a cache-buster and get each
// other's edge entry.
let probeCounter = 0;

/**
 * Probe the capacity-factors cache for the given years, sequentially — so the
 * probe never stampedes the upstream queue, and never masks a cold year by
 * racing another probe onto it.
 */
export async function probeYears(years: number[]): Promise<ProbeResult[]> {
  const baseUrl = getBaseUrl();
  const currentYear = currentDataYear();
  const results: ProbeResult[] = [];

  for (const year of years) {
    const tier = yearCachePolicy(year, currentYear).tier;
    const started = performance.now();

    // 1. Origin probe — the edge cannot answer a URL it has never seen.
    let status = 0;
    let ok = false;
    let dataCache: ProbeDataCache = {
      coldFetch: null,
      coldFetchMs: null,
      builtAt: null,
      ms: 0,
    };
    try {
      const originStarted = performance.now();
      const res = await fetch(
        // `probe` makes the URL unique so the edge cannot answer and the origin
        // must run — that is the point of this leg.
        `${baseUrl}${capacityFactorsPath(year)}&probe=${++probeCounter}`,
        { headers: { 'user-agent': 'coal-stripes-cache-probe' }, cache: 'no-store' },
      );
      const coldHeader = res.headers.get('x-cf-cold');
      status = res.status;
      ok = res.ok;
      dataCache = {
        coldFetch: coldHeader === null ? null : coldHeader === 'true',
        coldFetchMs: parseIntOrNull(res.headers.get('x-cf-cold-ms')),
        builtAt: res.headers.get('x-cf-built-at'),
        ms: Math.round(performance.now() - originStarted),
      };
    } catch {
      // Leave the defaults; classification falls through to 'uncertain'.
    }

    // 2. Edge probe — the real URL, exactly as a visitor requests it. That
    //    means the build id too: without it this measured an edge entry the
    //    browser never requests, so the verdict below described the wrong copy.
    let edge: ProbeEdge = { xVercelCache: null, age: null, ms: 0 };
    try {
      const edgeStarted = performance.now();
      const res = await fetch(`${baseUrl}${capacityFactorsPath(year)}`, {
        headers: { 'user-agent': 'coal-stripes-cache-probe' },
        cache: 'no-store',
      });
      await res.arrayBuffer();
      edge = {
        xVercelCache: res.headers.get('x-vercel-cache'),
        age: parseIntOrNull(res.headers.get('age')),
        ms: Math.round(performance.now() - edgeStarted),
      };
      if (!ok) {
        // The origin probe failed outright; report the edge's verdict instead.
        status = res.status;
        ok = res.ok;
      }
    } catch {
      // Leave the defaults; the edge simply reports as unknown.
    }

    results.push({
      year,
      tier,
      ms: Math.round(performance.now() - started),
      status,
      ok,
      edge,
      dataCache,
      classification: classifyProbe(ok, dataCache.ms, dataCache.coldFetch),
    });
  }

  return results;
}

/** The current year in NEM (Brisbane) time. */
export function currentDataYear(): number {
  return getTodayAEST().year;
}

/** The earliest year we hold data for. */
export function earliestDataYear(): number {
  return DATE_BOUNDARIES.EARLIEST_START_DATE.year;
}

/** Inclusive list of years `[from, to]`; empty when `to < from`. */
export function yearRange(from: number, to: number): number[] {
  const years: number[] = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
}
