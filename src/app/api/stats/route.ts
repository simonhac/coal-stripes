import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { computeCoalStats } from '@/server/coal-stats-service';
import type { FleetMode } from '@/shared/types';

// Force dynamic so our Cache-Control headers are honoured.
export const dynamic = 'force-dynamic';

// Bump when the computation or DTO shape changes (busts the Data Cache key).
// v5: the DTO gained `sources` (per-year provenance for the recency line on
// /stats); a v4 payload predates the field and would render without it.
const STATS_CACHE_VERSION = 'v5';
const DAY_SECONDS = 60 * 60 * 24;
const SWR_SECONDS = 60 * 60 * 24 * 7;

const FLEET_MODES: FleetMode[] = ['full', 'current'];

// One unstable_cache wrapper per fleet mode. The whole stats result is recomputed
// at most daily; the compute reuses the already-cached per-year capacity-factor
// payloads (self-fetched), so a warm run is cheap. The warm-stats cron fetches
// this after each daily refresh window so the recompute never lands on a user.
const statsCaches = Object.fromEntries(
  FLEET_MODES.map((mode) => [
    mode,
    unstable_cache(() => computeCoalStats(mode), ['coal-stats', STATS_CACHE_VERSION, mode], {
      revalidate: DAY_SECONDS,
      tags: ['coal-stats', mode],
    }),
  ]),
) as Record<FleetMode, () => ReturnType<typeof computeCoalStats>>;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const fleetParam = searchParams.get('fleet');
    if (fleetParam !== null && fleetParam !== 'full' && fleetParam !== 'current') {
      return NextResponse.json(
        { error: "Invalid fleet parameter (expected 'full' or 'current')" },
        { status: 400 },
      );
    }
    const mode: FleetMode = fleetParam === 'current' ? 'current' : 'full';

    const data = await statsCaches[mode]();

    const response = NextResponse.json(data);

    // Lets the purge endpoint invalidate this at the Vercel edge; revalidateTag
    // only reaches the Data Cache. See src/app/api/admin/purge/route.ts.
    response.headers.set('Vercel-Cache-Tag', `coal-stats,stats-${mode}`);

    // Short in the browser (the one cache nothing can purge), full day at the
    // edge — see the matching comment in the capacity-factors route.
    response.headers.set('Cache-Control', 'public, max-age=60');
    response.headers.set(
      'Vercel-CDN-Cache-Control',
      `public, s-maxage=${DAY_SECONDS}, stale-while-revalidate=${SWR_SECONDS}`,
    );
    response.headers.set('Vary', 'Accept-Encoding');
    return response;
  } catch (error) {
    console.error('Stats API Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
