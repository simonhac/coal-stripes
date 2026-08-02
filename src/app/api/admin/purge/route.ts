/**
 * One-click cache purge.
 *
 * The app holds data behind four caches, and until this endpoint existed there
 * was no way to clear them short of editing a version constant and deploying —
 * which meant "is OpenElectricity still missing this data, or am I looking at a
 * stale copy?" was a question you couldn't answer quickly. The layers, and how
 * each is cleared:
 *
 *   1. Next.js Data Cache (`unstable_cache` in the capacity-factors and stats
 *      routes) — cleared by revalidateTag() on the shared tags those wrappers
 *      already carry. This is the layer that shields the rate-limited
 *      OpenElectricity API, and the one that holds archive years for 7 days.
 *   2. Vercel CDN edge — NOT reachable by revalidateTag, because these routes
 *      are force-dynamic and set their own Cache-Control (Next never sees the
 *      entry). Cleared by invalidateByTag() against the `Vercel-Cache-Tag`
 *      header both routes now emit.
 *   3. The in-process facilities roster memo (24 h TTL) — cleared directly, but
 *      only on the instance that serves this request; see the caveat in the
 *      response.
 *   4. The browser HTTP cache — unreachable by anything, which is why both data
 *      routes now send only a 60 s browser max-age and keep the long window at
 *      the (purgeable) edge.
 *
 * Authorised with CACHE_SECRET — its own secret, separate from the cron token —
 * so a purge, which forces cold, rate-limited upstream fetches, can't be
 * triggered by a passer-by.
 *
 * Two modes, and they MUST be two separate requests. revalidateTag() invalidates
 * everything carrying that tag, including entries written later in the same
 * request — so re-warming inside the purge request writes cache entries that are
 * thrown away the moment it returns. (Verified: a year re-warmed in-request came
 * back cold on the very next call.) The /diagnostics button therefore issues
 * `purge` and then `rewarm` back to back; it is still one click.
 */

import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { invalidateByTag } from '@vercel/functions';
import {
  currentDataYear,
  earliestDataYear,
  getBaseUrl,
  isAuthorisedPurgeRequest,
  warmYears,
  yearRange,
  type WarmResult,
} from '@/server/cache-warmer';
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { getAESTDateTimeString } from '@/shared/date-utils';
import type { FleetMode } from '@/shared/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const FLEET_MODES: FleetMode[] = ['full', 'current'];

// Every cache tag the data routes emit at the top level. Tier/mode/year-specific
// tags hang off these, but purging the roots covers them all.
const DATA_CACHE_TAGS = ['capacity-factors', 'coal-stats'];

// Re-warming is deliberately bounded. A purge empties the Data Cache for all
// ~28 years, and re-warming every year in both fleet modes would mean ~56 cold
// fetches through a rate-limited queue — well past maxDuration. So we re-warm a
// small range (the years you're actually looking at) and let the warm-all cron,
// which runs every 10 minutes, refill the rest.
const MAX_REWARM_YEARS = 10;

type PurgeMode = 'purge' | 'rewarm';

interface PurgeStep {
  step: string;
  ok: boolean;
  detail: string;
}

interface PurgeRequestBody {
  mode?: PurgeMode;
  rewarmFrom?: number;
  rewarmTo?: number;
}

/** Resolve the re-warm range, defaulting to the current year alone. */
function resolveRewarmRange(
  body: PurgeRequestBody,
): { from: number; to: number } | { error: string } {
  const current = currentDataYear();
  const from = body.rewarmFrom ?? current;
  const to = body.rewarmTo ?? from;

  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { error: 'rewarmFrom/rewarmTo must be whole years' };
  }
  if (from < earliestDataYear() || to > current || from > to) {
    return {
      error: `Re-warm range out of bounds (${earliestDataYear()}-${current}, FROM <= TO)`,
    };
  }
  if (to - from + 1 > MAX_REWARM_YEARS) {
    return { error: `Re-warm range too wide (max ${MAX_REWARM_YEARS} years)` };
  }
  return { from, to };
}

export async function POST(request: Request) {
  if (!isAuthorisedPurgeRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  // An empty body is the common case (purge + re-warm the current year).
  let body: PurgeRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as PurgeRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const mode: PurgeMode = body.mode === 'rewarm' ? 'rewarm' : 'purge';

  const range = resolveRewarmRange(body);
  if ('error' in range) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  const started = performance.now();
  const steps: PurgeStep[] = [];
  const rewarm: WarmResult[] = [];

  if (mode === 'purge') {
    // 1. Next.js Data Cache. Synchronous and local to this request's cache
    //    context; it cannot meaningfully fail, but keep the shape uniform.
    try {
      for (const tag of DATA_CACHE_TAGS) revalidateTag(tag);
      steps.push({
        step: 'data-cache',
        ok: true,
        detail: `revalidateTag: ${DATA_CACHE_TAGS.join(', ')}`,
      });
    } catch (error) {
      steps.push({ step: 'data-cache', ok: false, detail: describe(error) });
    }

    // 2. Vercel CDN edge. There is no CDN outside a Vercel deployment, and
    //    invalidateByTag reports success there regardless — so gate on the
    //    environment rather than letting a silent no-op read as a real purge.
    if (!process.env.VERCEL) {
      steps.push({
        step: 'cdn-edge',
        ok: true,
        detail: 'skipped — no Vercel CDN outside a Vercel deployment',
      });
    } else {
      try {
        await invalidateByTag(DATA_CACHE_TAGS);
        steps.push({
          step: 'cdn-edge',
          ok: true,
          detail: `invalidateByTag: ${DATA_CACHE_TAGS.join(', ')}`,
        });
      } catch (error) {
        steps.push({
          step: 'cdn-edge',
          ok: false,
          detail: `invalidateByTag failed: ${describe(error)}`,
        });
      }
    }

    // 3. The facilities roster memo, on this instance.
    try {
      getCapFacDataService().clearFacilitiesCache();
      steps.push({
        step: 'facilities-memo',
        ok: true,
        detail: 'cleared on this instance only; others expire within 24 h',
      });
    } catch (error) {
      steps.push({ step: 'facilities-memo', ok: false, detail: describe(error) });
    }
  } else {
    // Re-warm only — a separate request, so these cache writes survive the
    // preceding purge. See the note at the top of this file.
    const years = yearRange(range.from, range.to);
    for (const fleet of FLEET_MODES) {
      rewarm.push(...(await warmYears(years, fleet)));
    }
    const failures = rewarm.filter((r) => !r.ok).length;
    steps.push({
      step: 'rewarm',
      ok: failures === 0,
      detail:
        `${years.length} year(s) x ${FLEET_MODES.length} fleet modes: ` +
        `${rewarm.length - failures} ok, ${failures} failed`,
    });
  }

  return NextResponse.json(
    {
      mode,
      purgedAt: getAESTDateTimeString(),
      baseUrl: getBaseUrl(),
      ok: steps.every((s) => s.ok),
      steps,
      rewarm: { from: range.from, to: range.to, results: rewarm },
      // Say plainly what was NOT done, so a purge is never mistaken for a full
      // refresh of every year.
      note:
        mode === 'purge'
          ? 'All cached years were discarded. Re-warm them with a follow-up ' +
            "request ({ mode: 'rewarm' }); the warm-all cron refills the rest " +
            'within 10 minutes.'
          : `Years outside ${range.from}-${range.to} are still cold; the warm-all ` +
            'cron refills them within 10 minutes. Until then, viewing one of those ' +
            'years (or /stats, which reads them all) will be slow.',
      totalMs: Math.round(performance.now() - started),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
