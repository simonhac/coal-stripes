import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
} from '@/server/cache-warmer';

// Weekly (see vercel.json). Warms the deep archive (everything older than the
// warm-recent window). This data is immutable and rarely viewed, so its only
// purpose is to recover from Data-Cache eviction within a week. A missing
// archive year also self-heals on the first real request, so this is a
// belt-and-braces guarantee, not the only line of defence.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const current = currentDataYear();
  const from = earliestDataYear();
  const to = current - 6;

  const warmed = await warmYears(yearRange(from, to));
  return NextResponse.json({ warmed });
}
