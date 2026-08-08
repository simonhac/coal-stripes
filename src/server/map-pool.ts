/**
 * Run `fn` over `items` with bounded concurrency, preserving input order.
 *
 * Used wherever we fan out across years — the store refresher and the stats
 * computation both do. The limit is what keeps a fan-out from becoming a
 * stampede: OpenElectricity never rate-limits us, but a cold year costs their
 * server about a second of work, so past ~4 years in flight the extra
 * parallelism buys no throughput and just makes everyone in the queue wait
 * longer (see docs/caching-and-diagnostics.md).
 *
 * A rejected `fn` rejects the whole call, exactly as `Promise.all` would;
 * callers that want per-item tolerance catch inside `fn`.
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
