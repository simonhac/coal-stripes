import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
  type WarmResult,
} from '@/server/cache-warmer';

// Runs every 10 minutes (see vercel.json). Warms EVERY year we hold data for, so
// no year — in any tier — stays cold for longer than the cron interval, whether
// it went cold from Data-Cache eviction or a fresh deployment wiping the cache.
// One entry per year covers both fleet views, since `current` is derived from
// the same payload in the browser (@/shared/fleet-filter).
//
// Each warm reads the Data Cache in-process and then refreshes the CDN edge (see
// warmYears); an already-warm year therefore costs a Data-Cache read plus one
// edge round-trip, no OpenElectricity call. The expensive work only happens
// right after a deploy or an eviction. This is the sole cache warmer — it
// supersedes the old per-tier warm-current/warm-recent/warm-archive crons (whose
// weekly archive cadence left deploy-cold years cold for days).
//
// The `rebuilt` count in the response (and the log line below) is the only
// visibility we have into how often the Vercel Data Cache actually evicts
// entries inside their revalidation window. Steady state should be 0; a
// persistent trickle means eviction is outpacing this sweep.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Stop starting new years at this point, leaving headroom under maxDuration for
// the years already in flight to finish. Measured when the sweep covered 56
// entries (two rosters per year): a fully-cold pass took ~220 s in dev over a
// mobile link. It is now ~28 entries, so the ceiling has roughly twice the
// headroom it did — kept as-is rather than tightened, since the slow case is
// upstream latency, not our own fan-out.
const WARM_BUDGET_MS = 240_000;

// Enough to identify a trickle of evictions by eye; a fully-cold sweep would
// otherwise print a paragraph, and in that case the count already tells the
// story.
const MAX_REBUILT_LISTED = 8;

/** `2007, 2013` — years that had to be rebuilt. */
function describeRebuilt(results: WarmResult[]): string {
  const listed = results
    .filter((r) => r.cold)
    .map((r) => r.year)
    .sort((a, b) => a - b);
  const shown = listed.slice(0, MAX_REBUILT_LISTED).join(', ');
  const overflow = listed.length - MAX_REBUILT_LISTED;
  return overflow > 0 ? `${shown}, +${overflow} more years` : shown;
}

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const started = performance.now();
  const deadline = started + WARM_BUDGET_MS;
  const years = yearRange(earliestDataYear(), currentDataYear());
  // One pass: warmYears fans out across years, and a single payload per year
  // serves both fleet views. The deadline means a slow fully-cold sweep stops
  // cleanly rather than being killed at maxDuration — and gets further on each
  // subsequent run.
  const warmed = await warmYears(years, { deadline });

  const rebuilt = warmed.filter((r) => r.cold).length;
  const skipped = warmed.filter((r) => r.skipped).length;
  const failed = warmed.filter((r) => !r.ok && !r.skipped).length;
  const totalMs = Math.round(performance.now() - started);

  console.log(
    `warm-all: ${warmed.length} entries, ${rebuilt} rebuilt` +
      (rebuilt > 0 ? ` (${describeRebuilt(warmed)})` : '') +
      (failed > 0 ? `, ${failed} failed` : '') +
      (skipped > 0 ? `, ${skipped} skipped (out of time)` : '') +
      `, ${totalMs} ms`,
  );

  return NextResponse.json({
    entries: warmed.length,
    rebuilt,
    failed,
    skipped,
    totalMs,
    warmed,
  });
}
