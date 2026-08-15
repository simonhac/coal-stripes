/**
 * Finding something that can actually purge.
 *
 * There are two candidates and neither is reliable on its own: `ctx.cache` is
 * typed optional and is absent outside a `scheduled` invocation, while the
 * module-level `cache` export is a stub under miniflare — which backs both
 * `vite dev` and `wrangler dev` — where `purge` is not a function at all.
 *
 * Shared by the store refresher and the post-deploy document purge so the two
 * can't drift on which one they trust. Deliberately silent: each caller logs its
 * own "nothing to purge here" line, because "refresh:purge-unavailable" and
 * "deploy-purge" answer different questions in a tail.
 */
import { cache } from 'cloudflare:workers';

export function resolvePurgeTarget(from?: CacheContext): CacheContext | undefined {
  return [from, cache].find((candidate) => typeof candidate?.purge === 'function');
}
