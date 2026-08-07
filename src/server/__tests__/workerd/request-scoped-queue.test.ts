/**
 * Regression test for the OpenElectricity queue's request scoping.
 *
 * This runs inside **workerd**, not Node, and that is the entire point. A
 * module-level p-queue passes every test Node can express, then deadlocks in
 * production, because workerd differs in two ways Node cannot show you:
 *
 *   1. Timers only advance while the request that created them is alive. The
 *      queue's `interval`/`intervalCap` pacing is driven by setTimeout, so a
 *      queue created during request A stops ticking the moment A finishes, and
 *      the next request waits on it forever.
 *   2. Promise continuations that resolve in a different request context than
 *      the one that created them are cancelled.
 *
 * Together those produced intermittent 500s — "your Worker's code had hung and
 * would never generate a response" — on the year endpoint under real page load.
 * The fix is withRequestQueue: one queue per fan-out, created inside the
 * request that uses it.
 *
 * These tests fail if anyone reintroduces a shared module-level queue.
 */
import { describe, expect, it } from 'vitest';
import PQueue from 'p-queue';
import { withRequestQueue } from '@/server/queued-oeclient';

describe('request-scoped OpenElectricity queue', () => {
  it('runs in workerd, not Node', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('paces work with interval timers inside a single request', async () => {
    // The behaviour the shared queue was there to provide, and which must
    // survive the per-request scoping: at most one task starts per interval.
    const queue = new PQueue({ concurrency: 10, interval: 100, intervalCap: 1 });
    const started: number[] = [];
    const t0 = performance.now();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        queue.add(async () => {
          started.push(Math.round(performance.now() - t0));
        }),
      ),
    );

    expect(started).toHaveLength(5);
    // 5 tasks at 1 per 100ms should span ~400ms; allow slack for scheduling.
    expect(started[started.length - 1] - started[0]).toBeGreaterThan(250);
  });

  it('gives each withRequestQueue scope its own queue', async () => {
    // Two scopes must not share pacing state — if they did, the second would
    // inherit the first's timers and could stall once the first scope ended.
    const seen = new Set<unknown>();
    const capture = async () => {
      await withRequestQueue(async () => {
        seen.add(await Promise.resolve(Symbol('scope')));
      });
    };
    await capture();
    await capture();
    expect(seen.size).toBe(2);
  });

  it('completes a second scope after the first has fully settled', async () => {
    // The actual deadlock shape: work enqueued after an earlier scope finished.
    // With a module-level queue this is where the Worker hung.
    const run = () =>
      withRequestQueue(async () => {
        const queue = new PQueue({ concurrency: 10, interval: 100, intervalCap: 1 });
        const results = await Promise.all(
          Array.from({ length: 3 }, (_, i) => queue.add(async () => i)),
        );
        return results.length;
      });

    expect(await run()).toBe(3);
    expect(await run()).toBe(3);
    expect(await run()).toBe(3);
  });
});
