/**
 * Run `fn` over `items` with bounded concurrency, preserving input order.
 *
 * Used wherever we fan out across years — the store refresher, the stats
 * computation, and the rebuild button on /diagnostics. The limit is what keeps
 * a fan-out from becoming a stampede: OpenElectricity never rate-limits us, but
 * a cold year costs their server about a second of work, so past ~4 years in
 * flight the extra parallelism buys no throughput and just makes everyone in the
 * queue wait longer (see docs/caching-and-diagnostics.md).
 *
 * It lives in `shared` rather than `server` because the diagnostics rebuild has
 * to bound its fan-out *in the browser*: each of its requests is a separate
 * Worker invocation, so no server-side queue can see them all. The function is
 * pure — no bindings, no imports — so both sides get the same one rather than
 * two that can drift.
 *
 * A rejected `fn` rejects the whole call, exactly as `Promise.all` would;
 * callers that want per-item tolerance catch inside `fn`. Progress reporting,
 * staggered starts and cancellation all belong inside `fn` too — that is what
 * keeps this one function serving three callers with different needs.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
