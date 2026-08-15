import { createFileRoute } from '@tanstack/react-router';
import { computeCoalStats } from '@/server/coal-stats-service';
import { coalStatsHeaders, NO_STORE } from '@/server/cache-headers';
import { getStats, putStats } from '@/server/year-store';

/**
 * Whole-of-history coal generation records.
 *
 * Precomputed into R2 by the cron, so the normal path here is a single R2 read
 * streamed through — no folding of 29 years, and no reading of 29 year payloads
 * to fold. Only a cold bucket reaches computeCoalStats, and that result is
 * stored on the way out.
 *
 * The route takes no parameters. There used to be a `?fleet=full|current`,
 * which forked the cache entry and doubled the warmer's work for a payload
 * nothing ever requested — /stats has only ever asked for the full fleet, and
 * a records-since-1998 table without Hazelwood and Liddell in it would be
 * missing the point. FleetMode stays what it is elsewhere: a client-side view
 * selector over the capacity-factors roster, in no server URL.
 */
export const Route = createFileRoute('/api/stats')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const stored = await getStats();
          if (stored) {
            const headers = coalStatsHeaders();
            headers.set('x-cf-source', 'r2');
            headers.set('Content-Type', 'application/json');
            return new Response(stored.body, { headers });
          }

          const data = await computeCoalStats();
          await putStats(data);

          const headers = coalStatsHeaders();
          headers.set('x-cf-source', 'upstream');
          return Response.json(data, { headers });
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
