import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { readEnv } from '@/server/runtime-env';

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
            // Via readEnv, not `env.` directly. Two reasons, and they compound:
            // `wrangler types` only puts a name in `Env` if it can see it —
            // bindings from wrangler.jsonc, vars from .dev.vars — so a secret
            // that exists only in the deployed Worker is absent from the
            // generated types, and a fresh workspace fails `npm run typecheck`
            // on this line alone. And this is a health check: it must report on
            // the lookup the *data path* actually performs, which is
            // readEnv('OPENELECTRICITY_API_KEY') in cap-fac-data-service.ts.
            // Reading `env.` here could answer false while fetches succeed.
            hasOpenElectricityKey: Boolean(readEnv('OPENELECTRICITY_API_KEY')),
            hasDataBucket: Boolean((env as { DATA?: unknown }).DATA),
            // `cf` is populated by Cloudflare's edge and absent in local dev.
            hasCf: Boolean(cf),
            colo: cf?.colo ?? null,
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      },
    },
  },
});
