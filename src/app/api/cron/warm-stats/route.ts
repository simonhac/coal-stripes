import { NextResponse } from 'next/server';
import { getBaseUrl, isAuthorisedCronRequest } from '@/server/cache-warmer';
import type { FleetMode } from '@/shared/types';

// The /api/stats result revalidates daily, but unstable_cache only RECOMPUTES a
// stale entry when something fetches it — so this cron is the load-bearing
// trigger that keeps the daily refresh from ever landing on a real user. It runs
// once a day (see vercel.json), after warm-all has kept the per-year caches warm,
// so the stats recompute only reads warm data.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MODES: FleetMode[] = ['full', 'current'];

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const baseUrl = getBaseUrl();
  const warmed: { mode: FleetMode; ok: boolean; status: number; ms: number }[] = [];

  // Sequential: the two modes each self-fetch ~28 cached years; running them one
  // at a time keeps well inside the rate-limited upstream queue on a cold sweep.
  for (const mode of MODES) {
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/stats?fleet=${mode}`, {
        headers: { 'user-agent': 'coal-stripes-stats-warmer' },
        cache: 'no-store',
      });
      warmed.push({ mode, ok: res.ok, status: res.status, ms: Math.round(performance.now() - started) });
    } catch {
      warmed.push({ mode, ok: false, status: 0, ms: Math.round(performance.now() - started) });
    }
  }

  return NextResponse.json({ warmed });
}
