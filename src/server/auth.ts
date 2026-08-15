/**
 * Bearer-token checks for the endpoints that must not be public.
 *
 * Both fail closed: an unset secret rejects every request rather than allowing
 * them, so a missing binding can't silently open the endpoint up.
 */
import { readEnv } from '@/server/runtime-env';

function matchesBearer(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * Guards the two endpoints that cost real money if a passer-by finds them:
 * /api/admin/purge and /api/admin/rebuild. One secret covers both — a rebuild is
 * strictly the more expensive of the two, so there is nothing a second secret
 * would protect that this one doesn't.
 *
 * Read through `readEnv` rather than `env` directly: under `vite dev` the
 * worker `env` and `process.env` are populated in different contexts, and a
 * CACHE_SECRET that only exists in `.env.local` would otherwise be invisible
 * here while OPENELECTRICITY_API_KEY was fine — see @/server/runtime-env.
 */
export function isAuthorisedPurgeRequest(request: Request): boolean {
  return matchesBearer(request, readEnv('CACHE_SECRET'));
}
