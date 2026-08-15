/**
 * Is this passcode right? Nothing else.
 *
 * Exists so the cache-management page can find out *before* it fans out. Without
 * it, a mistyped passcode spends 30 requests discovering the same 401 thirty
 * times and paints the failure across every row, which reads like the store is
 * broken rather than like a typo.
 *
 * No side effects, no body, no information: a 204 or a 401 and nothing else.
 * That is deliberate — this is the one endpoint an attacker can call cheaply in
 * a loop, so it must not become an oracle for anything except the secret it is
 * already guarding, and it must not be cheaper to probe than the work it gates.
 * (It is not rate-limited. Neither is /api/admin/purge, which fails the same way
 * for the same reason; the secret's length is what protects both.)
 */
import { createFileRoute } from '@tanstack/react-router';
import { isAuthorisedPurgeRequest } from '@/server/auth';
import { NO_STORE } from '@/server/cache-headers';

export const Route = createFileRoute('/api/admin/auth')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorisedPurgeRequest(request)) {
          return Response.json({ error: 'Unauthorised' }, { status: 401, headers: NO_STORE });
        }
        return new Response(null, { status: 204, headers: NO_STORE });
      },
    },
  },
});
