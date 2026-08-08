/**
 * Bearer-token checks for the endpoints that must not be public.
 *
 * Both fail closed: an unset secret rejects every request rather than allowing
 * them, so a missing binding can't silently open the endpoint up.
 */
import { env } from 'cloudflare:workers';

function matchesBearer(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

/**
 * A purge forces cold, rate-limited upstream fetches, so it gets its own secret
 * — separate from the cron token — and can't be triggered by a passer-by.
 */
export function isAuthorisedPurgeRequest(request: Request): boolean {
  return matchesBearer(request, (env as { CACHE_SECRET?: string }).CACHE_SECRET);
}
