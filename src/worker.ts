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

export default {
  fetch: startEntry.fetch,

  /**
   * The scheduled invocation itself is never cached — Cloudflare excludes
   * non-fetch handlers by design — but its loopback into the fetch entrypoint
   * is a fresh, cacheable invocation. That is what makes cron warming work at
   * all, and it is the opposite of what docs/cloudflare.md §3 predicted.
   */
  async scheduled(_event: ScheduledController, _env: unknown, ctx: ExecutionContext) {
    const summary = await warmAll();
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
