/**
 * One-click cache purge.
 *
 * This is what 218 lines of Vercel purge machinery collapse to. The old version
 * had to clear four layers by three mechanisms — `revalidateTag` for the Data
 * Cache, `invalidateByTag` from `@vercel/functions` for the CDN edge (which
 * revalidateTag could not reach, because the routes were force-dynamic and set
 * their own Cache-Control), and a direct call for the in-process roster memo —
 * and it carried a trap: `revalidateTag` also invalidated entries written later
 * in the same request, so purging and re-warming had to be two separate HTTP
 * calls or the re-warm was thrown away on return.
 *
 * Workers Cache is one layer with one purge, propagated globally by Instant
 * Purge. Purging is also no longer dangerous: the R2 store sits underneath, so
 * the next request rebuilds the cache entry from an R2 read rather than from
 * OpenElectricity. This endpoint does NOT touch R2 — the objects are the
 * durable copy, and dropping them would put the next visitor back on the slow
 * path this whole design exists to remove. To make a stored payload actually
 * change, rebuild it: POST /api/admin/rebuild, or the buttons on /diagnostics.
 * (The blunt instruments still work — bump CF_DTO_VERSION to rename the key
 * namespace, or `wrangler r2 object delete`.)
 *
 * The browser's own copy remains unreachable by any purge, which is why the data
 * routes send only a 60 s browser max-age and keep the long window on the
 * shared, purgeable copy.
 */
import { createFileRoute } from '@tanstack/react-router';
import { cache } from 'cloudflare:workers';
import { isAuthorisedPurgeRequest } from '@/server/auth';
import { DOCUMENT_TAG, NO_STORE } from '@/server/cache-headers';
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { getAESTDateTimeString } from '@/shared/date-utils';

// Every tag the routes emit at the top level. Tier-, year- and
// DTO-version-specific tags hang off the data ones, so purging the roots covers
// them.
//
// The document tag was here as an escape hatch, on the reasoning that cache keys
// include the Worker version (`cross_version_cache: false`) so a deploy already
// orphans the old document — "for the case that reasoning turns out to be wrong
// at 10 pm". On 2026-08-15 it was wrong at 10 pm: version keying starts a deploy
// cold but does not cover the flip itself, and one document written a second
// after it was served, 404ing, for the rest of its hour.
//
// So the tag is now also the mechanism — @/server/deploy-purge purges it from the
// cron on the ticks following a deploy. This endpoint keeps it because ten
// minutes is not the same as now.
const PURGE_TAGS = ['capacity-factors', 'coal-stats', DOCUMENT_TAG];

/**
 * Cloudflare caps a purge at 100 tags per request on every plan. The refresher
 * batches to stay under it; here it is a validation bound.
 */
const MAX_TAGS = 100;

/**
 * An optional `{ "tags": [...] }` body narrows the purge; no body means the
 * roots above, which is what the /diagnostics button and every curl in the docs
 * send. It exists so a single-year rebuild can drop just `cf-year-2004` rather
 * than every cached year and the SSR documents along with it.
 *
 * Anything unparseable falls back to the roots rather than erroring: this is the
 * escape hatch you reach for at 10 pm, and it should be hard to hold wrong.
 */
async function requestedTags(request: Request): Promise<string[]> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return PURGE_TAGS;
  }
  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags)) return PURGE_TAGS;

  const clean = tags.filter((t): t is string => typeof t === 'string' && t !== '');
  return clean.length === 0 ? PURGE_TAGS : clean.slice(0, MAX_TAGS);
}

export const Route = createFileRoute('/api/admin/purge')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorisedPurgeRequest(request)) {
          return Response.json(
            { error: 'Unauthorised' },
            { status: 401, headers: NO_STORE },
          );
        }

        const started = performance.now();

        const tags = await requestedTags(request);

        // Under miniflare — which backs both `vite dev` and `wrangler dev` —
        // the module-level `cache` is a stub and `purge` is not a function at
        // all. Say so instead of throwing: a local purge should read as "there
        // is no edge here", not as a production failure. Same check as
        // purgeChanged in @/server/store-refresher.
        const available = typeof cache?.purge === 'function';
        const result = available
          ? await cache.purge({ tags })
          : { success: true, errors: [] as unknown[] };

        // The 24 h facilities roster memo lives in module scope, so this only
        // clears it on the isolate that happens to serve this request. Other
        // isolates keep theirs until it expires. Called out in the response
        // rather than papered over.
        getCapFacDataService().clearFacilitiesCache();

        return Response.json(
          {
            purgedAt: getAESTDateTimeString(new Date()),
            tags,
            ok: result.success,
            errors: result.errors,
            purgeAvailable: available,
            note: !available
              ? 'No Workers Cache in this runtime (miniflare), so there was nothing to purge. The facilities memo was cleared.'
              : 'Workers Cache purged globally for the tags listed. R2 is untouched by design, so the next request refills the cache from the store rather than from OpenElectricity — and every payload keeps the x-cf-built-at it already had. To make that stamp move, rebuild the file (POST /api/admin/rebuild). The in-process facilities memo was cleared only on the isolate that served this request.',
            totalMs: Math.round(performance.now() - started),
          },
          { status: result.success ? 200 : 502, headers: NO_STORE },
        );
      },
    },
  },
});
