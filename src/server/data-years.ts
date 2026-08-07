/**
 * The span of years the app holds data for.
 *
 * Extracted from `cache-warmer.ts` when that module was deleted — these three
 * are pure date helpers with no Vercel or cache machinery in them, and the stats
 * service, the warmer and the purge endpoint all need them.
 */
import { DATE_BOUNDARIES } from '@/shared/config';
import { getTodayAEST } from '@/shared/date-utils';

/** The current year in NEM (Brisbane) time. */
export function currentDataYear(): number {
  return getTodayAEST().year;
}

/** The earliest year we hold data for. */
export function earliestDataYear(): number {
  return DATE_BOUNDARIES.EARLIEST_START_DATE.year;
}

/** Inclusive list of years `[from, to]`; empty when `to < from`. */
export function yearRange(from: number, to: number): number[] {
  const years: number[] = [];
  for (let y = from; y <= to; y++) years.push(y);
  return years;
}

/** Every year we hold data for, oldest first. */
export function allDataYears(): number[] {
  return yearRange(earliestDataYear(), currentDataYear());
}
