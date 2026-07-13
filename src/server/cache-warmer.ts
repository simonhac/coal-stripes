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
import { DATE_BOUNDARIES } from '@/shared/config';

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
function getBaseUrl(): string {
  // Production uses the stable project domain; previews use the deployment URL.
  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (host) return `https://${host}`;
  // Local development.
  return `http://localhost:${process.env.PORT ?? '3000'}`;
}

export interface WarmResult {
  year: number;
  ok: boolean;
  status: number;
  ms: number;
}

/**
 * Warm the capacity-factors cache for the given years.
 *
 * Years are warmed sequentially to respect the rate-limited upstream request
 * queue. The internal fetch deliberately carries no `Authorization` header (so
 * the CDN will cache the response) and uses `no-store` so the warmer's own
 * fetch is never short-circuited by Next's fetch cache.
 */
export async function warmYears(years: number[]): Promise<WarmResult[]> {
  const baseUrl = getBaseUrl();
  const results: WarmResult[] = [];

  for (const year of years) {
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/capacity-factors?year=${year}`, {
        headers: { 'user-agent': 'coal-stripes-cache-warmer' },
        cache: 'no-store',
      });
      results.push({
        year,
        ok: res.ok,
        status: res.status,
        ms: Math.round(performance.now() - started),
      });
    } catch {
      results.push({
        year,
        ok: false,
        status: 0,
        ms: Math.round(performance.now() - started),
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
