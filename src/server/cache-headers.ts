/**
 * The Workers Cache contract, in one place.
 *
 * This replaces the entire Vercel arrangement: `unstable_cache` tier wrappers,
 * the `inFlight` single-flight map, `Vercel-CDN-Cache-Control`,
 * `Vercel-Cache-Tag`, and the `&v=BUILD_ID` URL buster. Workers Cache sits in
 * front of the Worker, is configured purely by these response headers, and
 * collapses concurrent misses itself — so one visitor's cold fetch is shared
 * with everyone waiting behind it rather than each starting their own.
 */
import { CF_DTO_VERSION, yearCachePolicy } from '@/shared/config';

/** Tags every capacity-factor response carries, for `cache.purge({ tags })`. */
export function capacityFactorTags(year: number, tier: string): string {
  return [
    'capacity-factors',
    `cf-${tier}`,
    `cf-year-${year}`,
    `cf-dto-${CF_DTO_VERSION}`,
  ].join(',');
}

/** Tags for the derived coal-stats responses. */
export function coalStatsTags(mode: string): string {
  return ['coal-stats', `stats-${mode}`, `cf-dto-${CF_DTO_VERSION}`].join(',');
}

/**
 * Cache headers for one year's payload.
 *
 * Two lifetimes in one header: `max-age` governs the browser, `s-maxage`
 * governs Workers Cache. The browser copy is the one layer no purge can reach,
 * so it stays short — a fix must never be masked by a copy sitting in someone's
 * browser — while the shared copy keeps the full freshness-tier window.
 * TanStack Query already dedupes within a session, so the short browser max-age
 * costs at most one edge round-trip per year per page load.
 *
 * `stale-while-revalidate` is emitted but is currently a **no-op**: Workers
 * Cache does not serve stale, it blocks and revalidates (measured on Free and
 * Paid — .context/spike/RESULTS.md). It is left in so the behaviour improves by
 * itself if Cloudflare ships it. Until then the cron warmer, not swr, is what
 * keeps visitors off the cold path.
 */
export function capacityFactorHeaders(
  year: number,
  currentYear: number,
  builtAt: string,
): Headers {
  const policy = yearCachePolicy(year, currentYear);
  const headers = new Headers();

  // When this payload was actually assembled from OpenElectricity — NOT when it
  // was read from a cache. It travels with the body, so a copy replayed from
  // Workers Cache still reports its true age.
  headers.set('x-cf-built-at', builtAt);
  headers.set('Cache-Tag', capacityFactorTags(year, policy.tier));

  if (year > currentYear) {
    // Future years: never cache, the data does not exist yet. This must be
    // explicit — a response with NO Cache-Control gets cached anyway.
    headers.set('Cache-Control', 'no-store');
  } else {
    headers.set(
      'Cache-Control',
      `public, max-age=60, s-maxage=${policy.revalidateSeconds}, stale-while-revalidate=${policy.swrSeconds}`,
    );
  }

  headers.set('Vary', 'Accept-Encoding');
  return headers;
}

/** Coal-stats responses: one day shared, one minute in the browser. */
export function coalStatsHeaders(mode: string): Headers {
  const headers = new Headers();
  headers.set(
    'Cache-Control',
    'public, max-age=60, s-maxage=86400, stale-while-revalidate=604800',
  );
  headers.set('Cache-Tag', coalStatsTags(mode));
  headers.set('Vary', 'Accept-Encoding');
  return headers;
}

/** For anything that must never be cached. Never rely on omitting Cache-Control. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
