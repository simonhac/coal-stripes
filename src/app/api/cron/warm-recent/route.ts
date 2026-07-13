import { NextResponse } from 'next/server';
import {
  currentDataYear,
  earliestDataYear,
  isAuthorisedCronRequest,
  warmYears,
  yearRange,
} from '@/server/cache-warmer';

// Daily just after Brisbane midnight (see vercel.json). Warms the last five
// past years — the most-viewed history, and the window that includes the
// just-ended year right after New Year (before it can be requested cold under
// its new "previous-years" cache key).
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const current = currentDataYear();
  const from = Math.max(earliestDataYear(), current - 5);
  const to = current - 1;

  const warmed = await warmYears(yearRange(from, to));
  return NextResponse.json({ warmed });
}
