import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { CF_DTO_VERSION } from '@/shared/config';
import { RECOVERY_BACKOFF_MS, startFailedYearRecovery } from '../failed-year-recovery';

/**
 * The unit project runs in plain Node, so there is no DOM. These stand in for
 * the two globals the module wires listeners onto, which lets the focus /
 * visibilitychange / online paths be exercised rather than skipped.
 */
type Listeners = Map<string, Set<() => void>>;

function fakeEventTarget(listeners: Listeners) {
  return {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
}

function dispatch(listeners: Listeners, type: string) {
  for (const fn of listeners.get(type) ?? []) fn();
}

describe('failed-year-recovery', () => {
  let queryClient: QueryClient;
  let listeners: Listeners;
  let stop: (() => void) | undefined;

  const yearKey = (year: number) => ['capFacYear', 'full', year, CF_DTO_VERSION];

  /** Drive a year query to a terminal error, with retries off for speed. */
  const failYear = async (year: number, queryFn: () => Promise<unknown>) => {
    await queryClient
      .fetchQuery({ queryKey: yearKey(year), queryFn, retry: false })
      .catch(() => {});
  };

  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    // A single map behind both, so `focus` and `visibilitychange` are
    // dispatchable by name regardless of which global they were bound to.
    const target = fakeEventTarget(listeners);
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    queryClient.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries a failed year after the first backoff step, and stops once it succeeds', async () => {
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValue('ok');

    await failYear(2000, queryFn);
    expect(queryFn).toHaveBeenCalledTimes(1);

    stop = startFailedYearRecovery(queryClient);

    // Nothing before the first step elapses.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0] - 1);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(yearKey(2000))).toBe('ok');

    // Healed, so no further polling — this is the guard against leaving a
    // timer running for the life of the tab.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS.at(-1)! * 3);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('backs off further on each successive failure', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await failYear(2000, queryFn);
    stop = startFailedYearRecovery(queryClient);

    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);
    expect(queryFn).toHaveBeenCalledTimes(2);

    // The second wait is the *next* rung, so the first rung's worth of time is
    // not enough on its own.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);
    expect(queryFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[1] - RECOVERY_BACKOFF_MS[0]);
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('retries immediately on focus, visibilitychange and online, and restarts the ladder', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await failYear(2000, queryFn);
    stop = startFailedYearRecovery(queryClient);

    // Climb to a long rung first, so the reset is observable.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[1]);
    expect(queryFn).toHaveBeenCalledTimes(3);

    dispatch(listeners, 'focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(4);

    dispatch(listeners, 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(5);

    dispatch(listeners, 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(6);

    // The ladder is back at rung 0 — a reader who has just come back should not
    // serve out a delay accrued while the tab was hidden.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);
    expect(queryFn).toHaveBeenCalledTimes(7);
  });

  it('ignores visibilitychange when the tab has gone away', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await failYear(2000, queryFn);
    stop = startFailedYearRecovery(queryClient);

    vi.stubGlobal('document', {
      ...fakeEventTarget(listeners),
      visibilityState: 'hidden',
    });
    dispatch(listeners, 'visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('never touches a healthy year', async () => {
    // The whole reason this is predicate-driven rather than a blanket refetch:
    // rebuilding every facility's canvas on every tab focus is what
    // refetchOnWindowFocus: false exists to prevent.
    const goodFn = vi.fn().mockResolvedValue('ok');
    const badFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));

    await queryClient.fetchQuery({ queryKey: yearKey(2015), queryFn: goodFn, retry: false });
    await failYear(2000, badFn);
    expect(goodFn).toHaveBeenCalledTimes(1);

    stop = startFailedYearRecovery(queryClient);
    dispatch(listeners, 'focus');
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);

    expect(badFn.mock.calls.length).toBeGreaterThan(1);
    expect(goodFn).toHaveBeenCalledTimes(1);
  });

  it('leaves non-year queries alone', async () => {
    const statsFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await queryClient
      .fetchQuery({ queryKey: ['coalStats', 2000], queryFn: statsFn, retry: false })
      .catch(() => {});

    stop = startFailedYearRecovery(queryClient);
    dispatch(listeners, 'focus');
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS.at(-1)!);

    expect(statsFn).toHaveBeenCalledTimes(1);
  });

  it('picks up a year that fails after it started watching', async () => {
    stop = startFailedYearRecovery(queryClient);

    const queryFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await failYear(2000, queryFn);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS[0]);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('stops polling and unbinds on teardown', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    await failYear(2000, queryFn);

    const teardown = startFailedYearRecovery(queryClient);
    teardown();

    dispatch(listeners, 'focus');
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS.at(-1)! * 2);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
  });
});
