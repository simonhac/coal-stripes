/**
 * Reading our own cached endpoints from inside the Worker.
 *
 * This is the piece that deletes `src/server/cache-warmer.ts`. On Vercel there
 * were two incompatible ways to reach a year's payload — an in-process call that
 * warmed the Data Cache but not the edge, and an HTTP self-fetch that warmed the
 * edge but not the Data Cache — and getting that wrong was a documented
 * production failure. Workers Cache has one layer, and one way in.
 *
 * `ctx.exports` routes a call back into our own entrypoint *through* Workers
 * Cache, so a loopback is a cache read that only falls through to
 * OpenElectricity on a genuine miss. Measured: 542 ms cold, then 6 ms / 4 ms /
 * 3 ms warm (.context/spike/RESULTS.md).
 *
 * Two things that are NOT interchangeable with this:
 *   - A plain `fetch()` to our own public hostname. Undocumented as cacheable,
 *     and fetching a Cloudflare-fronted host from a Worker trips error 1042.
 *   - Calling CapFacDataService directly. That bypasses the cache entirely, so
 *     /api/stats would pay 28 cold OpenElectricity fetches on every rebuild.
 */
import { env, exports as workerExports } from 'cloudflare:workers';
import { capacityFactorsPath } from '@/shared/capacity-factors-url';

/**
 * Whether a self-loopback is possible at all.
 *
 * It is NOT possible under miniflare — which is what backs both `vite dev` and
 * `wrangler dev`. A Worker calling its own entrypoint there is detected as a
 * deadlock and **the whole request is cancelled**, not just the one call. That
 * cancellation is fatal and cannot be caught: wrapping the call in try/catch
 * still loses the request, because any other loopback already in flight takes it
 * down. So this has to be decided *before* attempting one.
 *
 * Deployed, it works and is fast — 3–4 ms warm (.context/spike/RESULTS.md).
 *
 *   `__LOOPBACK_ENABLED__`  injected false by vite.config.ts when running the
 *                           dev server (`command === 'serve'`). Left UNDEFINED
 *                           outside Vite — notably under Jest, where the
 *                           `cloudflare:workers` mock does provide a working
 *                           loopback — so absent means enabled. It is a `define`
 *                           rather than `import.meta.env.DEV` because Jest's CJS
 *                           transform cannot parse `import.meta` at all.
 *   `CF_LOOPBACK=off`       covers `wrangler dev` on a production build. Passed
 *                           by the `preview` script as `--var`, NOT via a
 *                           `.dev.vars` file: creating one makes wrangler read
 *                           vars from it *instead of* `.env.local`, silently
 *                           stripping OPENELECTRICITY_API_KEY and turning every
 *                           year into "API key not configured".
 */
declare const __LOOPBACK_ENABLED__: boolean | undefined;

export function loopbackAvailable(): boolean {
  if (typeof __LOOPBACK_ENABLED__ !== 'undefined' && !__LOOPBACK_ENABLED__) {
    return false;
  }
  return (env as { CF_LOOPBACK?: string }).CF_LOOPBACK !== 'off';
}

/**
 * The default entrypoint, as reachable from inside the Worker.
 *
 * The cache key includes which entrypoint served the request, so warming or
 * reading MUST go through `default` — the same entrypoint public traffic hits.
 * A loopback into a named entrypoint would populate a different key and warm
 * nothing that anyone reads.
 *
 * Typed loosely because `Cloudflare.Exports` is only inferred when
 * `GlobalProps.mainModule` is declared, and our main module is
 * `@tanstack/react-start/server-entry`.
 */
const self = workerExports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
};

/**
 * Origin used to build loopback URLs. The host is not part of the cache key —
 * only the path and query string are — so this only has to be a well-formed
 * absolute URL, not a reachable one.
 */
const LOOPBACK_ORIGIN = 'https://stripes.energy';

export function loopbackUrl(path: string): string {
  return `${LOOPBACK_ORIGIN}${path}`;
}

/** Fetch one of our own routes through Workers Cache. */
export function loopback(path: string): Promise<Response> {
  return self.default.fetch(new Request(loopbackUrl(path)));
}

/** One year's payload, from cache when warm. `null` if the route errored. */
export async function loopbackYear<T>(year: number): Promise<T | null> {
  const res = await loopback(capacityFactorsPath(year));
  if (!res.ok) {
    // Drain, so the subrequest doesn't stay open.
    await res.arrayBuffer();
    return null;
  }
  return (await res.json()) as T;
}
