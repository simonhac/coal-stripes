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
import { cache } from 'cloudflare:workers';
import { COAL_STATS_TAG, yearTag } from '@/server/cache-headers';
import { allDataYears, currentDataYear } from '@/server/data-years';
import { mapPool } from '@/server/map-pool';
import { computeCoalStats } from '@/server/coal-stats-service';
import { windowsOverdue } from '@/server/refresh-schedule';
import { buildYear, putStats, statsIsDue, yearFreshness } from '@/server/year-store';

/** Stop starting new work after this long, so a sweep can't overrun its cron. */
const REFRESH_BUDGET_MS = 240_000;

/**
 * How far past its window a year may drift before the sweep says so.
 *
 * A healthy sweep rebuilds within one cron interval of a slot boundary, so
 * anything at twice its window has been failing for a while — an expired API
 * key, an upstream outage, a budget that keeps running out. Until now that only
 * showed up as an `x-cf-built-at` header nobody was watching.
 */
const STALE_WINDOW_MULTIPLE = 2;

/** Cloudflare caps a purge at 100 operations per request, on every plan. */
const PURGE_TAGS_PER_CALL = 100;

/**
 * How many years to rebuild at once. OpenElectricity never rate-limits us, but
 * a cold year costs their server about a second, so past ~4 in flight the extra
 * parallelism buys no throughput and just makes everyone in the queue wait.
 */
const REFRESH_CONCURRENCY = 5;

/**
 * `changed` and `unchanged` are both rewrites; they differ only in whether the
 * numbers moved. `deferred` means the budget ran out before this year was
 * reached, which is worth telling apart from a year that simply wasn't due.
 */
type YearOutcome = 'changed' | 'unchanged' | 'skipped' | 'deferred' | 'failed';

export interface RefreshSummary {
  /** Years rebuilt from OpenElectricity. */
  written: number;
  /** ...of which the numbers actually moved. */
  changed: number;
  skipped: number;
  deferred: number;
  failed: number;
  /** Years already past STALE_WINDOW_MULTIPLE of their window when the sweep began. */
  stale: number;
  statsWritten: boolean;
  statsChanged: boolean;
  purgedTags: number;
  totalMs: number;
}

interface YearResult {
  outcome: YearOutcome;
  /** Already well past its window when the sweep found it — earlier ticks failed. */
  stale: boolean;
}

async function refreshYear(year: number): Promise<YearResult> {
  try {
    const { due, ageSeconds } = await yearFreshness(year);
    if (!due) return { outcome: 'skipped', stale: false };

    const overdue =
      ageSeconds === null ? 0 : windowsOverdue(year, currentDataYear(), ageSeconds);
    const stale = overdue >= STALE_WINDOW_MULTIPLE;
    if (stale) {
      console.warn(JSON.stringify({
        log: 'refresh:stale',
        year,
        ageSeconds: Math.round(ageSeconds ?? 0),
        windowsOverdue: Number(overdue.toFixed(1)),
      }));
    }

    const { changed } = await buildYear(year);
    return { outcome: changed ? 'changed' : 'unchanged', stale };
  } catch (error) {
    console.error(JSON.stringify({
      log: 'refresh:year-failed',
      year,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { outcome: 'failed', stale: false };
  }
}

/**
 * Drop the edge copies of whatever this sweep actually changed.
 *
 * Without this the R2 write is invisible: Workers Cache holds its copy for the
 * full `s-maxage`, which is the same window the refresher runs on, so a reader
 * could see a payload up to *two* windows old. Measured on 2026-08-09, the
 * stats response being served was 8 hours behind the object in R2 and pinned
 * there for another 16 — every one of that day's ~24 folds was invisible.
 *
 * Only changed payloads are purged. A rebuild that produced identical numbers
 * has nothing to show anyone, and purging it would just cost the next reader an
 * edge miss for no new data.
 *
 * Purging from `scheduled` is not the same thing as *caching* from `scheduled`,
 * which Cloudflare documents as impossible (see the header comment). This is a
 * control-plane call and does not read or write the cache — but that is
 * reasoning, not measurement, so the outcome is logged rather than assumed.
 */
async function purgeChanged(tags: string[], from?: CacheContext): Promise<number> {
  if (tags.length === 0) return 0;

  // `ctx.cache` is typed optional and the module-level export is a stub under
  // miniflare, where `purge` is not a function at all. Resolve rather than
  // assume, and say so once instead of throwing per batch: a local sweep should
  // not look like a production failure.
  const target = [from, cache].find(
    (candidate) => typeof candidate?.purge === 'function',
  );
  if (!target) {
    console.log(JSON.stringify({ log: 'refresh:purge-unavailable', tags: tags.length }));
    return 0;
  }

  let purged = 0;
  for (let i = 0; i < tags.length; i += PURGE_TAGS_PER_CALL) {
    const batch = tags.slice(i, i + PURGE_TAGS_PER_CALL);
    try {
      const result = await target.purge({ tags: batch });
      if (result.success) {
        purged += batch.length;
      } else {
        console.error(JSON.stringify({ log: 'refresh:purge-rejected', errors: result.errors }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        log: 'refresh:purge-failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return purged;
}

/**
 * Sweep every year, then the stats, then purge whatever moved.
 *
 * Order matters twice. Stats fold the year payloads, so rebuilding them first
 * would fold the previous generation's numbers and then immediately be a day
 * stale. And the purge comes last, once both are written: purging before the
 * store is updated would send the next reader to R2 for the copy we were about
 * to replace.
 *
 * Most ticks write nothing. Each year costs one R2 HEAD to find out it is not
 * due yet — 28 HEADs every ten minutes is ~121k class-B ops a month against a
 * 10M allowance, and the writes that do happen are ~1k class-A a month against
 * 1M. The free tier covers this comfortably; the Workers Paid plan is needed
 * for the CPU to build a payload, not for the storage.
 *
 * Total work is unchanged by the per-year phases in @/server/refresh-schedule —
 * ~32 year-builds a day either way. What changes is that they are spread across
 * the 144 ticks instead of arriving as one weekly burst of 28.
 */
export async function refreshAll(cacheContext?: CacheContext): Promise<RefreshSummary> {
  const started = performance.now();
  const years = allDataYears();

  // mapPool preserves order, so results[i] is the outcome for years[i].
  const results = await mapPool(years, REFRESH_CONCURRENCY, async (year): Promise<YearResult> => {
    if (performance.now() - started > REFRESH_BUDGET_MS) {
      return { outcome: 'deferred', stale: false };
    }
    return refreshYear(year);
  });

  const outcomes = results.map((r) => r.outcome);
  const changedYears = years.filter((_, i) => outcomes[i] === 'changed');
  const written = outcomes.filter((o) => o === 'changed' || o === 'unchanged').length;
  const failed = outcomes.filter((o) => o === 'failed').length;

  // Refold the stats when a year's numbers moved — nothing else feeds them, so
  // an unchanged set of years means an identical result — or when the stored
  // payload is missing or a day old. That second condition is the backstop: if
  // a tick rewrites years and the fold then fails, every later tick would see
  // an unchanged set and never retry.
  //
  // The trigger is `changed`, not `written`: before payload hashing, a rebuild
  // that re-fetched byte-identical numbers still counted, so the current year's
  // hourly rewrite refolded the stats ~24 times a day to produce the same
  // answer.
  let statsWritten = false;
  let statsChanged = false;
  if (changedYears.length > 0 || (await statsIsDue())) {
    try {
      const write = await putStats(await computeCoalStats());
      statsWritten = true;
      statsChanged = write.changed;
    } catch (error) {
      console.error(JSON.stringify({
        log: 'refresh:stats-failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const purgedTags = await purgeChanged(
    [...changedYears.map(yearTag), ...(statsChanged ? [COAL_STATS_TAG] : [])],
    cacheContext,
  );

  return {
    written,
    changed: changedYears.length,
    skipped: outcomes.filter((o) => o === 'skipped').length,
    deferred: outcomes.filter((o) => o === 'deferred').length,
    failed,
    stale: results.filter((r) => r.stale).length,
    statsWritten,
    statsChanged,
    purgedTags,
    totalMs: Math.round(performance.now() - started),
  };
}
