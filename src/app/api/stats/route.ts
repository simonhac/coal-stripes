import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { computeCoalStats } from '@/server/coal-stats-service';
import type { FleetMode } from '@/shared/types';

// Force dynamic so our Cache-Control headers are honoured.
export const dynamic = 'force-dynamic';

// Bump when the computation or DTO shape changes (busts the Data Cache key).
const STATS_CACHE_VERSION = 'v3';
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
    response.headers.set(
      'Cache-Control',
      `public, max-age=${DAY_SECONDS}, s-maxage=${DAY_SECONDS}, stale-while-revalidate=${SWR_SECONDS}`,
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
