/**
 * The Worker entrypoint.
 *
 * TanStack Start's own `@tanstack/react-start/server-entry` only exports a
 * `fetch` handler, so this wraps it to add `scheduled` for the cache warmer.
 * `wrangler.jsonc` points `main` here instead.
 *
 * Keeping the DEFAULT export is load-bearing, not stylistic: the Workers Cache
 * key includes which entrypoint served a request, and the warmer reaches this
 * same entrypoint via `ctx.exports.default` (see @/server/loopback). A named
 * entrypoint would populate a different key and warm nothing anyone reads.
 */
import startEntry from '@tanstack/react-start/server-entry';
import { warmAll } from '@/server/cache-warmer';
import { withSelfFetch } from '@/server/loopback';

export default {
  fetch: startEntry.fetch,

  /**
   * The scheduled invocation itself is never cached — Cloudflare excludes
   * non-fetch handlers by design — but its loopback into the fetch entrypoint
   * is a fresh, cacheable invocation. That is what makes cron warming work at
   * all, and it is the opposite of what docs/cloudflare.md §3 predicted.
   */
  async scheduled(_event: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    // Warm with a PLAIN OUTBOUND FETCH to the public hostname, not a loopback.
    //
    // A loopback via `exports.default` (module-level or `ctx.exports`) does not
    // populate the entries external traffic reads on this deployment: Start
    // ships static assets, so public requests are routed through an
    // assets-aware wrapper and `exports.default` is a different cache key. Both
    // loopback flavours were tried; both reported rebuilding all 28 years while
    // external requests kept missing. Silent, and exactly the Vercel
    // "warmed the wrong layer" failure in new clothing.
    //
    // Going out through the edge is by construction the same path a visitor
    // takes, which is what makes the warmer's effect observable with curl.
    const summary = await withSelfFetch((request) => fetch(request), () => warmAll());
    console.log(JSON.stringify({ log: 'warm-all', ...summary, warmed: undefined }));

    // Surface anything that failed; a silent warmer is how the Vercel one hid a
    // production failure for as long as it did.
    const failures = summary.warmed.filter((w) => !w.ok);
    if (failures.length) {
      console.error(JSON.stringify({ log: 'warm-all:failures', failures }));
    }
    ctx.waitUntil(Promise.resolve());
  },
};
