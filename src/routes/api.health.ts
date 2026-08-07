import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

/**
 * Scaffold smoke test: proves a Start server route runs on workerd, can read a
 * Worker secret, and that an explicit `no-store` really does bypass Workers
 * Cache. (A response with no Cache-Control at all gets cached — see
 * .context/spike/RESULTS.md.)
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
        return Response.json(
          {
            ok: true,
            runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
            hasOpenElectricityKey: Boolean(env.OPENELECTRICITY_API_KEY),
            // `cf` is populated by Cloudflare's edge and absent in local dev —
            // which is how we tell whether a self-loopback is possible.
            hasCf: Boolean(cf),
            colo: cf?.colo ?? null,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      },
    },
  },
});
