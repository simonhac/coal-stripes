/**
 * What's in the R2 store, right now.
 *
 * The cache-management page used to answer this by requesting all 29 years the
 * way a visitor would — ~5 MB of payloads downloaded to read three response
 * headers, slow enough that it had to be a button you pressed rather than
 * something the page just showed you. And it warmed the cache it was measuring.
 *
 * A HEAD carries `customMetadata` without the body, so the same three stamps
 * cost a few hundred bytes for the whole store. That is the difference between
 * a page you have to operate and a page you can just look at.
 *
 * Unauthenticated, deliberately. Every stamp here is already public: the data
 * routes emit `x-cf-built-at` and `x-cf-data-changed-at` on every response, and
 * /api/stats publishes per-year `builtAt` in its `sources` block. Gating it
 * would buy no secrecy and would leave the table blank until someone typed a
 * passcode. The passcode still guards every *write* — see api.admin.rebuild.
 */
import { createFileRoute } from '@tanstack/react-router';
import { NO_STORE } from '@/server/cache-headers';
import { storeStatus } from '@/server/year-store';

export const Route = createFileRoute('/api/admin/store')({
  server: {
    handlers: {
      GET: async () => {
        const started = performance.now();
        const entries = await storeStatus();
        return Response.json(
          { entries, totalMs: Math.round(performance.now() - started) },
          { headers: NO_STORE },
        );
      },
    },
  },
});
