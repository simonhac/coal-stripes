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
import startEntry from '@tanstack/react-start/server-entry';
import { refreshAll } from '@/server/store-refresher';

export default {
  fetch: startEntry.fetch,

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
   */
  async scheduled(_event: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    const summary = await refreshAll(ctx.cache);
    console.log(JSON.stringify({ log: 'refresh', ...summary }));
  },
};
