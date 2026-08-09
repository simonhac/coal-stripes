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

/**
 * The tag identifying one year's response. Exported on its own because the store
 * refresher purges by it after a rewrite — if this and the emitted header ever
 * drifted apart, the purge would silently hit nothing.
 */
export function yearTag(year: number): string {
  return `cf-year-${year}`;
}

/** The tag on the derived coal-stats response, purged the same way. */
export const COAL_STATS_TAG = 'coal-stats';

/** Tags every capacity-factor response carries, for `cache.purge({ tags })`. */
export function capacityFactorTags(year: number, tier: string): string {
  return [
    'capacity-factors',
    `cf-${tier}`,
    yearTag(year),
    `cf-dto-${CF_DTO_VERSION}`,
  ].join(',');
}

/** Tags for the derived coal-stats response. */
export function coalStatsTags(): string {
  return [COAL_STATS_TAG, `cf-dto-${CF_DTO_VERSION}`].join(',');
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
 * itself if Cloudflare ships it. Nothing depends on it: what keeps visitors off
 * the cold path is R2 underneath, which never expires, so the request that
 * revalidates pays an R2 read rather than an OpenElectricity fetch.
 */
export function capacityFactorHeaders(
  year: number,
  currentYear: number,
  builtAt: string,
  dataChangedAt?: string,
): Headers {
  const policy = yearCachePolicy(year, currentYear);
  const headers = new Headers();

  // When this payload was actually assembled from OpenElectricity — NOT when it
  // was read from a cache. It travels with the body, so a copy replayed from
  // Workers Cache still reports its true age.
  headers.set('x-cf-built-at', builtAt);
  // When the numbers last actually moved, as opposed to when we last checked.
  // The pair answers a question the tiers were set by guesswork: does
  // OpenElectricity ever revise a year from the 2000s? If these stay far apart
  // for archive years, the weekly rebuild is buying nothing and the window can
  // be lengthened on evidence.
  if (dataChangedAt) headers.set('x-cf-data-changed-at', dataChangedAt);
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

/** Coal-stats response: one day shared, one minute in the browser. */
export function coalStatsHeaders(): Headers {
  const headers = new Headers();
  headers.set(
    'Cache-Control',
    'public, max-age=60, s-maxage=86400, stale-while-revalidate=604800',
  );
  headers.set('Cache-Tag', coalStatsTags());
  headers.set('Vary', 'Accept-Encoding');
  return headers;
}

/** For anything that must never be cached. Never rely on omitting Cache-Control. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** The tag every SSR document carries, so /api/admin/purge can reach them. */
export const DOCUMENT_TAG = 'html';

/**
 * The SSR document's policy.
 *
 * `max-age=0`: the browser copy is the one layer no purge can reach, and the
 * document is ~3.5 KB — the same reasoning that keeps the data routes at 60 s,
 * taken to its limit.
 *
 * `s-maxage=3600`: an hour rather than a day because the streamed shell embeds a
 * per-render timestamp in its `$_TSR.router` payload. Staleness *across deploys*
 * is not what this bounds — that is `cross_version_cache: false` in
 * wrangler.jsonc, without which no s-maxage short enough to be safe would be
 * long enough to be worth having.
 *
 * NO `no-transform`, deliberately: Cloudflare's automatic Web Analytics
 * injection stops silently if the response carries it, and `curl -I` cannot see
 * that it has (docs/caching-and-diagnostics.md § Analytics).
 */
export const DOCUMENT_CACHE_CONTROL = 'public, max-age=0, s-maxage=3600';

/**
 * Give the SSR document an explicit cache policy on its way out.
 *
 * Until this existed the document set no `Cache-Control` at all and was cached
 * anyway — workerd has no "force-dynamic" equivalent, so omitting the header
 * chooses a policy rather than declining to. This states the choice.
 *
 * Only `text/html` responses that have not already set a policy are touched:
 * `/api/*` sends its own headers, `NO_STORE` means it, and static assets are
 * served before the Worker runs and never arrive here at all.
 *
 * The body is passed through untouched — never read. The document is streamed,
 * and buffering it here would put the shell's time-to-first-byte back where #27
 * found it.
 */
export function applyDocumentCacheHeaders(response: Response): Response {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('text/html')) return response;
  if (response.headers.has('Cache-Control')) return response;

  const withHeaders = new Response(response.body, response);
  withHeaders.headers.set('Cache-Control', DOCUMENT_CACHE_CONTROL);
  withHeaders.headers.set('Cache-Tag', DOCUMENT_TAG);
  return withHeaders;
}
