import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * Bring failed year tiles back on their own.
 *
 * TanStack gives a year four attempts over ~7 seconds (`retry` in
 * providers.tsx and year-queries.ts) and then stops for good. After that the
 * only things that re-fetch are a *new* subscription — panning the year out of
 * the window and back, a fleet-mode switch, an adjacent-year prefetch — or the
 * `online` event, which a phone changing cells often never fires. A year that
 * fails while it is on screen therefore stays a pale-blue block until the
 * reader reloads the page, which is exactly the bug this module fixes.
 *
 * Two rules shape the design:
 *
 *   1. Only *errored* year queries are refetched. A blanket refetch is what
 *      `refetchOnWindowFocus: false` (providers.tsx) exists to prevent — it
 *      would rebuild every facility's canvas on every tab focus.
 *   2. The backoff is much slower than the in-fetch retry ladder. This is the
 *      long tail after the fast attempts have already lost, so it is measured
 *      in tens of seconds, not milliseconds.
 */

/** Query-key roots owned by year-queries.ts — the two layers of one year. */
const YEAR_QUERY_ROOTS: ReadonlySet<string> = new Set(['capFacYear', 'capFacYearData']);

/**
 * Delays between successive background attempts, in ms. The last entry repeats
 * forever: a reader who leaves a broken tab open on a dead connection should
 * keep the poll cheap, not give up.
 */
export const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000];

/** Matches a year query that has given up. Used as the refetch predicate. */
export function isFailedYearQuery(query: Query): boolean {
  return (
    query.state.status === 'error' && YEAR_QUERY_ROOTS.has(query.queryKey[0] as string)
  );
}

export function hasFailedYearQuery(queryClient: QueryClient): boolean {
  return queryClient.getQueryCache().getAll().some(isFailedYearQuery);
}

/**
 * Start watching for failed years. Returns the teardown function.
 *
 * Refetching the outer `capFacYear` layer is enough on its own — its queryFn
 * calls `fetchQuery` on the payload layer, which has no data and is therefore
 * permanently stale, so it genuinely goes back to the network. The payload
 * layer is matched too, so an errored payload with no view over it (a failed
 * adjacent-year prefetch) also heals; the two dedupe into one request.
 */
export function startFailedYearRecovery(queryClient: QueryClient): () => void {
  let step = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (stopped || timer !== undefined) return;
    if (!hasFailedYearQuery(queryClient)) {
      step = 0;
      return;
    }
    const delay = RECOVERY_BACKOFF_MS[Math.min(step, RECOVERY_BACKOFF_MS.length - 1)];
    timer = setTimeout(() => {
      timer = undefined;
      step += 1;
      void attempt();
    }, delay);
  };

  const attempt = async () => {
    if (stopped) return;
    if (!hasFailedYearQuery(queryClient)) {
      clearTimer();
      step = 0;
      return;
    }
    // cancelRefetch: false so the focus and visibilitychange that both fire on
    // a tab return join one in-flight refetch instead of cancelling and
    // restarting it.
    await queryClient.refetchQueries({ predicate: isFailedYearQuery }, { cancelRefetch: false });
    schedule();
  };

  /**
   * Retry at once and restart the ladder. Wired to the moments connectivity is
   * most likely to have just returned — which is also why the ladder resets:
   * a reader who has come back to the tab should not wait out a 2-minute delay
   * accrued while it was hidden.
   */
  const retryNow = () => {
    if (stopped) return;
    clearTimer();
    step = 0;
    void attempt();
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') retryNow();
  };

  // Only year-query events can change whether anything is broken, and the
  // cache emits on every tile fetch across ~28 years × 2 modes, so filter
  // before touching the cache.
  //
  // Deliberately one-directional: this only ever *starts* the ladder. A query
  // with no data flips to `pending` for the duration of a refetch, so reacting
  // to the absence of failures here would reset the backoff on every attempt
  // and poll forever at the first rung. Cancellation is left to `attempt`,
  // which finds nothing broken and clears — at worst one idle wake-up after a
  // year heals by some other route.
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (!YEAR_QUERY_ROOTS.has(event.query.queryKey[0] as string)) return;
    if (hasFailedYearQuery(queryClient)) schedule();
  });

  const hasDocument = typeof document !== 'undefined';
  const hasWindow = typeof window !== 'undefined';
  if (hasDocument) document.addEventListener('visibilitychange', onVisibilityChange);
  if (hasWindow) {
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
  }

  // Something may already have failed before this ran — a prefetch during the
  // first paint, say.
  schedule();

  return () => {
    stopped = true;
    clearTimer();
    unsubscribe();
    if (hasDocument) document.removeEventListener('visibilitychange', onVisibilityChange);
    if (hasWindow) {
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
    }
  };
}
