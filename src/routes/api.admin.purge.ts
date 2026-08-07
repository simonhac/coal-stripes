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
 * Purge, and it does not invalidate writes that follow. So purge and re-warm can
 * safely be the same request — though re-warming is left to the cron, which
 * sweeps every year every ten minutes anyway.
 *
 * The browser's own copy remains unreachable by any purge, which is why the data
 * routes send only a 60 s browser max-age and keep the long window on the
 * shared, purgeable copy.
 */
import { createFileRoute } from '@tanstack/react-router';
import { cache } from 'cloudflare:workers';
import { isAuthorisedPurgeRequest } from '@/server/auth';
import { NO_STORE } from '@/server/cache-headers';
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { getAESTDateTimeString } from '@/shared/date-utils';

// Every tag the data routes emit at the top level. Tier-, year- and
// DTO-version-specific tags hang off these, so purging the roots covers them.
const DATA_CACHE_TAGS = ['capacity-factors', 'coal-stats'];

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

        const result = await cache.purge({ tags: DATA_CACHE_TAGS });

        // The 24 h facilities roster memo lives in module scope, so this only
        // clears it on the isolate that happens to serve this request. Other
        // isolates keep theirs until it expires. Called out in the response
        // rather than papered over.
        getCapFacDataService().clearFacilitiesCache();

        return Response.json(
          {
            purgedAt: getAESTDateTimeString(new Date()),
            tags: DATA_CACHE_TAGS,
            ok: result.success,
            errors: result.errors,
            note:
              'Workers Cache purged globally. The in-process facilities memo was cleared only on the isolate that served this request; the cron warmer refills year payloads within ten minutes.',
            totalMs: Math.round(performance.now() - started),
          },
          { status: result.success ? 200 : 502, headers: NO_STORE },
        );
      },
    },
  },
});
