/**
 * The Worker entrypoint.
 *
 * TanStack Start's own `@tanstack/react-start/server-entry` only exports a
 * `fetch` handler, so this wraps it to add `scheduled` for the store refresher.
 * `wrangler.jsonc` points `main` here instead.
 *
 * Keeping the DEFAULT export is load-bearing, not stylistic: the Workers Cache
 * key includes which entrypoint served a request, so a named entrypoint would
 * populate a different key from the one visitors read.
 */
import { now } from '@internationalized/date';
import startEntry from '@tanstack/react-start/server-entry';
import { applyDocumentCacheHeaders } from '@/server/cache-headers';
import { purgeDocumentsAfterDeploy } from '@/server/deploy-purge';
import { refreshAll } from '@/server/store-refresher';

const startFetch = startEntry.fetch;

export default {
  /**
   * Start renders the document; this only stamps a cache policy on it.
   *
   * It belongs here rather than in a route because there is no route to put it
   * in — `/`, `/stats` and `/diagnostics` are all rendered by Start's own
   * handler, and this is the one place every one of them passes through. The
   * headers themselves, and why the document needs them at all, are in
   * @/server/cache-headers.
   */
  fetch: async (...args: Parameters<typeof startFetch>) =>
    applyDocumentCacheHeaders(await startFetch(...args)),

  /**
   * Keep the R2 store current.
   *
   * This handler deliberately does NOT try to *warm* Workers Cache. Cloudflare
   * excludes scheduled invocations from the cache entirely, subrequests
   * included, so warming from here is impossible — see @/server/store-refresher
   * and docs/workers-behaviour-measured.md. Bindings work normally, which is
   * why the store is R2 and not a warm cache.
   *
   * Purging is a different thing and is passed `ctx.cache` for it: a purge is a
   * control-plane call that neither reads nor writes the cache, and without it
   * an R2 rewrite stays invisible behind the edge copy for a further full
   * `s-maxage`.
   *
   * The document purge runs FIRST, and not because it is more important — it is
   * a no-op on all but the one or two ticks that follow a deploy. It runs first
   * because a sweep may take minutes, and on the tick that matters those are
   * minutes of the site rendering nothing but its spinner. See
   * @/server/deploy-purge.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await purgeDocumentsAfterDeploy(env.CF_VERSION, now('UTC'), ctx.cache);

    const summary = await refreshAll(ctx.cache);
    console.log(JSON.stringify({ log: 'refresh', ...summary }));
  },
};
