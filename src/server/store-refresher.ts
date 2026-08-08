/**
 * The cron's job: keep the R2 store current.
 *
 * This replaces the cache warmer, which could not work and never did. Cloudflare
 * documents that scheduled invocations "always run without cache involvement",
 * subrequests included, so no cron can populate Workers Cache by any means —
 * four mechanisms were tried against the live deployment and all failed. See
 * docs/workers-behaviour-measured.md for how a spike produced a false positive
 * on exactly this point.
 *
 * Bindings are not subject to that limitation, so writing to R2 from `scheduled`
 * works normally. That inverts the design: instead of trying to keep a cache
 * warm so visitors never fall through it, we make falling through cheap. Workers
 * Cache is now just an accelerator, and nothing breaks when it is cold.
 *
 * There is no `unreached` counter any more. It existed to detect a warmer that
 * reported success while achieving nothing; the equivalent signal now is the
 * `x-cf-source` header on a real request, which is observable from outside and
 * cannot be fooled by the prober warming what it measures.
 */
import { allDataYears } from '@/server/data-years';
import { mapPool } from '@/server/map-pool';
import { computeCoalStats } from '@/server/coal-stats-service';
import { buildYear, putStats, statsIsDue, yearIsDue } from '@/server/year-store';

/** Stop starting new work after this long, so a sweep can't overrun its cron. */
const REFRESH_BUDGET_MS = 240_000;

/**
 * How many years to rebuild at once. OpenElectricity never rate-limits us, but
 * a cold year costs their server about a second, so past ~4 in flight the extra
 * parallelism buys no throughput and just makes everyone in the queue wait.
 */
const REFRESH_CONCURRENCY = 5;

type YearOutcome = 'written' | 'skipped' | 'failed';

export interface RefreshSummary {
  written: number;
  skipped: number;
  failed: number;
  statsWritten: boolean;
  totalMs: number;
}

async function refreshYear(year: number): Promise<YearOutcome> {
  try {
    if (!(await yearIsDue(year))) return 'skipped';
    await buildYear(year);
    return 'written';
  } catch (error) {
    console.error(JSON.stringify({
      log: 'refresh:year-failed',
      year,
      error: error instanceof Error ? error.message : String(error),
    }));
    return 'failed';
  }
}

/**
 * Sweep every year, then the stats.
 *
 * Order matters: stats fold the year payloads, so rebuilding them first would
 * fold the previous generation's numbers and then immediately be a day stale.
 *
 * Most ticks write nothing. Each year costs one R2 HEAD to find out it is not
 * due yet — 28 HEADs every ten minutes is ~121k class-B ops a month against a
 * 10M allowance, and the writes that do happen are ~1k class-A a month against
 * 1M. The free tier covers this comfortably; the Workers Paid plan is needed
 * for the CPU to build a payload, not for the storage.
 */
export async function refreshAll(): Promise<RefreshSummary> {
  const started = performance.now();
  const years = allDataYears();

  const outcomes = await mapPool(years, REFRESH_CONCURRENCY, async (year): Promise<YearOutcome> => {
    if (performance.now() - started > REFRESH_BUDGET_MS) return 'skipped';
    return refreshYear(year);
  });

  const written = outcomes.filter((o) => o === 'written').length;
  const failed = outcomes.filter((o) => o === 'failed').length;

  // Refold the stats when a year moved — nothing else feeds them, so an
  // unchanged set of years means an identical result — or when the stored
  // payload is missing or a day old. That second condition is the backstop: if
  // a tick rewrites years and the fold then fails, every later tick would see
  // an unchanged set and never retry.
  let statsWritten = false;
  if (written > 0 || (await statsIsDue())) {
    try {
      await putStats(await computeCoalStats());
      statsWritten = true;
    } catch (error) {
      console.error(JSON.stringify({
        log: 'refresh:stats-failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return {
    written,
    skipped: outcomes.filter((o) => o === 'skipped').length,
    failed,
    statsWritten,
    totalMs: Math.round(performance.now() - started),
  };
}
