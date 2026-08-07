/**
 * The one way to build a capacity-factors request URL.
 *
 * Every caller — the browser, the cron warmer, the stats service — must request
 * the SAME url, because Workers Cache keys on the path *and the full query
 * string*, in order (`?a=1&b=2` and `?b=2&a=1` are different entries). Two
 * callers that differ by a single parameter are using two different cache
 * entries, so one can warm or measure a copy the other never sees. This module
 * exists so that can't drift again.
 *
 * There is deliberately no `&v=` cache-buster any more. Under Vercel the URL had
 * to rotate per deploy, because the browser and edge caches keyed on the URL
 * while the Data Cache keyed on the year — three layers that could disagree
 * about which deploy's payload shape they held. Workers Cache is one layer, and
 * invalidation is by Cache-Tag (`cf-dto-<CF_DTO_VERSION>`, see
 * src/shared/config.ts), so the URL is now stable across deploys — which is the
 * point of `cross_version_cache`.
 */

/** Same-origin path. Prefix with an origin for loopback fetches. */
export function capacityFactorsPath(year: number): string {
  return `/api/capacity-factors?year=${year}`;
}
