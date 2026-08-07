import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
  type WarmResult,
} from '@/server/cache-warmer';

// Runs every 10 minutes (see vercel.json). Warms EVERY year we hold data for, in
// BOTH fleet modes (full/current, which are cached separately), so no year — in
// any tier or mode — stays cold for longer than the cron interval, whether it
// went cold from Data-Cache eviction or a fresh deployment wiping the cache.
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
// the years already in flight to finish. Measured: a fully-cold 56-entry sweep
// takes ~220 s in dev over a mobile link, so the ceiling is real but not
// routinely hit — and only a fully-cold sweep (i.e. just after a deploy) gets
// anywhere near it.
const WARM_BUDGET_MS = 240_000;

// Enough to identify a trickle of evictions by eye; a fully-cold sweep (every
// year, both modes) would otherwise print a paragraph, and in that case the
// count already tells the story.
const MAX_REBUILT_LISTED = 8;

/** `2007 full, 2013 full/current` — years that had to be rebuilt, grouped. */
function describeRebuilt(results: WarmResult[]): string {
  const byYear = new Map<number, string[]>();
  for (const r of results) {
    if (!r.cold) continue;
    const modes = byYear.get(r.year) ?? [];
    modes.push(r.mode);
    byYear.set(r.year, modes);
  }
  const listed = [...byYear.entries()].sort(([a], [b]) => a - b);
  const shown = listed
    .slice(0, MAX_REBUILT_LISTED)
    .map(([year, modes]) => `${year} ${modes.join('/')}`)
    .join(', ');
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
  // Warm the default `full` roster first (the one most users hit), then
  // `current`. Sequential between modes so the two don't compete for the
  // upstream queue; warmYears fans out across years within each mode. Both
  // share one deadline, so a slow fully-cold sweep stops cleanly rather than
  // being killed at maxDuration — and gets further on each subsequent run.
  const warmedFull = await warmYears(years, 'full', { deadline });
  const warmedCurrent = await warmYears(years, 'current', { deadline });
  const warmed = [...warmedFull, ...warmedCurrent];

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
