/**
 * Cache warming for the capacity-factors API.
 *
 * The owner never wants the app to hit a cold cache. The only cache layer that
 * shields a slow upstream OpenElectricity fetch is the Vercel Data Cache (the
 * `unstable_cache` in the capacity-factors route) plus the regional CDN edge.
 * These are populated by whoever makes the first request after an entry is
 * missing/evicted — this module makes that "first request" a scheduled cron
 * instead of an unlucky user.
 *
 * Warming works by issuing an internal, UNauthenticated GET to the public
 * route. Because the request carries no `Authorization` header, its response is
 * CDN-cacheable, so a single warm populates BOTH the Data Cache and the CDN
 * region. Years that are already warm cost only a Data-Cache read; only
 * missing/stale years actually call OpenElectricity.
 */

import { getTodayAEST } from '@/shared/date-utils';
import {
  DATE_BOUNDARIES,
  yearCachePolicy,
  type YearCacheTier,
} from '@/shared/config';
import type { FleetMode } from '@/shared/types';

/**
 * Verify a request came from Vercel Cron (or another authorised caller).
 *
 * When the `CRON_SECRET` environment variable is set, Vercel automatically
 * attaches `Authorization: Bearer <CRON_SECRET>` to cron invocations. We fail
 * closed: if no secret is configured, no caller is authorised.
 */
export function isAuthorisedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
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

export interface WarmResult {
  year: number;
  mode: FleetMode;
  ok: boolean;
  status: number;
  ms: number;
}

/**
 * Warm the capacity-factors cache for the given years, for one fleet mode.
 *
 * The two fleet modes (`full`/`current`) are cached under separate keys, so
 * each must be warmed independently. Years are warmed sequentially to respect
 * the rate-limited upstream request queue. The internal fetch deliberately
 * carries no `Authorization` header (so the CDN will cache the response) and
 * uses `no-store` so the warmer's own fetch is never short-circuited by Next's
 * fetch cache.
 */
export async function warmYears(years: number[], mode: FleetMode): Promise<WarmResult[]> {
  const baseUrl = getBaseUrl();
  const results: WarmResult[] = [];

  for (const year of years) {
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/capacity-factors?year=${year}&fleet=${mode}`, {
        headers: { 'user-agent': 'coal-stripes-cache-warmer' },
        cache: 'no-store',
      });
      results.push({
        year,
        mode,
        ok: res.ok,
        status: res.status,
        ms: Math.round(performance.now() - started),
      });
    } catch {
      results.push({
        year,
        mode,
        ok: false,
        status: 0,
        ms: Math.round(performance.now() - started),
      });
    }
  }

  return results;
}

/**
 * Diagnostics: probe (rather than warm) the cache for a set of years.
 *
 * `warmYears` above only needs to know whether the warm succeeded; the
 * diagnostics endpoint additionally wants to know HOW the response was served
 * (warm Data-Cache read vs cold OpenElectricity fetch) so "is cron caching
 * working?" becomes a reproducible check. This is a read-only sibling — it does
 * not mutate the lean `WarmResult` shape the crons depend on.
 *
 * Honest signals, in order of trust (see classifyProbe):
 *  1. `x-vercel-cache: HIT` / `age > 0` — the regional CDN edge served a cached
 *     copy (fast, warm). Trusted first because an edge HIT replays whatever
 *     `x-cf-cold` header was cached with the original response, which may be
 *     stale.
 *  2. `x-cf-cold` — set by the data route itself (see capacity-factors/route),
 *     true when THIS request synchronously ran a cold OpenElectricity fetch.
 *     Authoritative whenever the request actually reached the function.
 *  3. Latency — sub-second means no cold fetch happened; multi-second means one
 *     did. A proxy, used only when the headers above are absent (e.g. locally,
 *     where there is no CDN).
 */

// Latency bands (ms). ~700ms is a warm Data-Cache hit even on an edge MISS; a
// cold OpenElectricity fetch (rate-limited, retried, 2-network fan-out) is
// multi-second.
export const PROBE_WARM_MAX_MS = 1500;
export const PROBE_COLD_MIN_MS = 3000;

export type TileClassification = 'warm' | 'cold' | 'uncertain';

export interface ProbeResult {
  year: number;
  tier: YearCacheTier;
  ms: number;
  status: number;
  ok: boolean;
  xVercelCache: string | null; // HIT | MISS | STALE | PRERENDER | null (no CDN, e.g. local dev)
  age: number | null; // CDN Age header, seconds
  coldFetch: boolean | null; // from x-cf-cold; null when the header is absent
  coldFetchMs: number | null; // from x-cf-cold-ms
  classification: TileClassification;
}

function classifyProbe(
  ok: boolean,
  ms: number,
  xVercelCache: string | null,
  age: number | null,
  coldFetch: boolean | null,
): TileClassification {
  if (!ok) return 'uncertain';
  // 1. Edge served a cached copy → warm. (Ignore a possibly-stale x-cf-cold.)
  if (xVercelCache?.toUpperCase() === 'HIT' || (age !== null && age > 0)) {
    return 'warm';
  }
  // 2. The function ran and told us definitively.
  if (coldFetch === true) return 'cold';
  if (coldFetch === false) return 'warm';
  // 3. Latency fallback (no CDN / no marker header).
  if (ms <= PROBE_WARM_MAX_MS) return 'warm';
  if (ms >= PROBE_COLD_MIN_MS) return 'cold';
  return 'uncertain';
}

function parseIntOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Probe the capacity-factors cache for the given years, sequentially (to
 * respect the rate-limited upstream queue if any year is cold). Like
 * `warmYears`, the self-fetch carries no `Authorization` header (so it exercises
 * the same CDN-cacheable path a real user hits) and uses `no-store` so Next's
 * fetch cache never short-circuits the probe.
 */
export async function probeYears(years: number[]): Promise<ProbeResult[]> {
  const baseUrl = getBaseUrl();
  const currentYear = currentDataYear();
  const results: ProbeResult[] = [];

  for (const year of years) {
    const tier = yearCachePolicy(year, currentYear).tier;
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/capacity-factors?year=${year}`, {
        headers: { 'user-agent': 'coal-stripes-cache-probe' },
        cache: 'no-store',
      });
      const ms = Math.round(performance.now() - started);
      const xVercelCache = res.headers.get('x-vercel-cache');
      const age = parseIntOrNull(res.headers.get('age'));
      const coldHeader = res.headers.get('x-cf-cold');
      const coldFetch = coldHeader === null ? null : coldHeader === 'true';
      const coldFetchMs = parseIntOrNull(res.headers.get('x-cf-cold-ms'));
      results.push({
        year,
        tier,
        ms,
        status: res.status,
        ok: res.ok,
        xVercelCache,
        age,
        coldFetch,
        coldFetchMs,
        classification: classifyProbe(res.ok, ms, xVercelCache, age, coldFetch),
      });
    } catch {
      results.push({
        year,
        tier,
        ms: Math.round(performance.now() - started),
        status: 0,
        ok: false,
        xVercelCache: null,
        age: null,
        coldFetch: null,
        coldFetchMs: null,
        classification: 'uncertain',
      });
    }
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
