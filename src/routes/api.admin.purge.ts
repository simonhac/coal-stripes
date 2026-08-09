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
 * path this whole design exists to remove. To force a genuine rebuild, bump
 * CF_DTO_VERSION (which renames the key namespace) or delete objects directly
 * with `wrangler r2 object delete`.
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
// The document tag is an escape hatch, not the mechanism. Cache keys include the
// Worker version (`cross_version_cache: false`), so a deploy already orphans the
// old document rather than leaving it to be purged. This is for the case that
// reasoning turns out to be wrong at 10 pm.
const PURGE_TAGS = ['capacity-factors', 'coal-stats', DOCUMENT_TAG];

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

        const result = await cache.purge({ tags: PURGE_TAGS });

        // The 24 h facilities roster memo lives in module scope, so this only
        // clears it on the isolate that happens to serve this request. Other
        // isolates keep theirs until it expires. Called out in the response
        // rather than papered over.
        getCapFacDataService().clearFacilitiesCache();

        return Response.json(
          {
            purgedAt: getAESTDateTimeString(new Date()),
            tags: PURGE_TAGS,
            ok: result.success,
            errors: result.errors,
            note:
              'Workers Cache purged globally, data responses and SSR documents alike. R2 is untouched, so the next request for each year refills the cache from the store, not from OpenElectricity. The in-process facilities memo was cleared only on the isolate that served this request.',
            totalMs: Math.round(performance.now() - started),
          },
          { status: result.success ? 200 : 502, headers: NO_STORE },
        );
      },
    },
  },
});
