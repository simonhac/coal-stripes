import { createFileRoute } from '@tanstack/react-router';
import { computeCoalStats } from '@/server/coal-stats-service';
import { coalStatsHeaders, NO_STORE } from '@/server/cache-headers';
import type { FleetMode } from '@/shared/types';

/**
 * Whole-of-history coal generation records.
 *
 * The `unstable_cache` wrapper the Next version used is gone: Workers Cache
 * holds the response for a day (see coalStatsHeaders) and collapses concurrent
 * misses, so this handler only runs on a real rebuild. The rebuild itself is
 * cheap because computeCoalStats reads its 28 years back through the cache via
 * a loopback — see @/server/loopback.
 *
 * `?fleet=` is validated rather than defaulted silently, because the two modes
 * are separate cache entries (the key includes the query string) and a typo
 * would otherwise quietly populate a third.
 */
export const Route = createFileRoute('/api/stats')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { searchParams } = new URL(request.url);
          const fleetParam = searchParams.get('fleet');
          if (fleetParam !== null && fleetParam !== 'full' && fleetParam !== 'current') {
            return Response.json(
              { error: "Invalid fleet parameter (expected 'full' or 'current')" },
              { status: 400, headers: NO_STORE },
            );
          }
          const mode: FleetMode = fleetParam === 'current' ? 'current' : 'full';

          const data = await computeCoalStats(mode);

          return Response.json(data, { headers: coalStatsHeaders(mode) });
        } catch (error) {
          console.error('Stats API Error:', error);
          return Response.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500, headers: NO_STORE },
          );
        }
      },
    },
  },
});
