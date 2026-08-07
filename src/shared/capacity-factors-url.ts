/**
 * The one way to build a capacity-factors request URL.
 *
 * Every caller — the browser, the cron warmer's edge refresh, the diagnostics
 * probe, the stats service — must request the SAME url, because the CDN keys on
 * the whole query string. Two callers that differ by a single parameter are
 * using two different edge entries, so one can warm or measure a copy the other
 * never sees. This module exists so that can't drift again.
 *
 * `v` is the per-deploy build id (see next.config.ts). It rotates the URL each
 * deploy, so the browser and Vercel-edge HTTP caches (both keyed on the URL)
 * miss and refetch, while the origin Data Cache — keyed on year and
 * CF_CACHE_VERSION, not the URL — still answers without an OpenElectricity
 * fetch. That is also what stops a server-side caller from being handed a
 * previous deploy's payload shape by the edge.
 */

// Inlined at build time by next.config.ts `env`, which covers both the client
// and server bundles. Falls back to a stable `dev` off-Vercel.
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

/** Same-origin path; prefix with a base URL for server-side self-fetches. */
export function capacityFactorsPath(year: number): string {
  return `/api/capacity-factors?year=${year}&v=${BUILD_ID}`;
}
