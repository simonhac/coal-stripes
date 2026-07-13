import { NextResponse } from 'next/server';
import {
  currentDataYear,
  isAuthorisedCronRequest,
  warmYears,
} from '@/server/cache-warmer';

// Hourly (see vercel.json). Warms the current year, whose data changes daily.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isAuthorisedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const warmed = await warmYears([currentDataYear()]);
  return NextResponse.json({ warmed });
}
