import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
} from '@/server/cache-warmer';

// Runs every 10 minutes (see vercel.json). Warms EVERY year we hold data for, in
// BOTH fleet modes (full/current, which are cached separately), so no year — in
// any tier or mode — stays cold for longer than the cron interval, whether it
// went cold from Data-Cache eviction or a fresh deployment wiping the cache.
// Warming an already-warm year costs only a Data-Cache read (no OpenElectricity
// call), so a full sweep is cheap in steady state; the expensive work only
// happens right after a deploy/eviction. This is the sole cache warmer — it
// supersedes the old per-tier warm-current/warm-recent/warm-archive crons (whose
// weekly archive cadence left deploy-cold years cold for days). A 10-minute
// cadence keeps the post-deploy cold window small; a fully-cold sweep (now ~28
// years × 2 modes) runs through the rate-limited upstream queue, well inside the
// maxDuration window below.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const years = yearRange(earliestDataYear(), currentDataYear());
  // Warm the default `full` roster first (the one most users hit), then
  // `current`. Sequential so we don't burst the rate-limited upstream queue.
  const warmedFull = await warmYears(years, 'full');
  const warmedCurrent = await warmYears(years, 'current');
  return NextResponse.json({ warmed: [...warmedFull, ...warmedCurrent] });
}
