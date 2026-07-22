import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
} from '@/server/cache-warmer';

// Runs every 10 minutes (see vercel.json). Warms EVERY year we hold data for, so
// no year — in any tier — stays cold for longer than the cron interval, whether
// it went cold from Data-Cache eviction or a fresh deployment wiping the cache.
// Warming an already-warm year costs only a Data-Cache read (no OpenElectricity
// call), so a full sweep is cheap in steady state; the expensive work only
// happens right after a deploy/eviction. This is the sole cache warmer — it
// supersedes the old per-tier warm-current/warm-recent/warm-archive crons (whose
// weekly archive cadence left deploy-cold years cold for days). A 10-minute
// cadence keeps the post-deploy cold window small; a fully-cold sweep takes
// ~60-90s through the rate-limited upstream queue, well inside that interval.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const warmed = await warmYears(
    yearRange(earliestDataYear(), currentDataYear()),
  );
  return NextResponse.json({ warmed });
}
