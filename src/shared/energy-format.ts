/**
 * Display formatting for the coal-generation stats page.
 *
 * Energy totals span a huge range — a single day is a few hundred GWh, a year
 * is a couple of hundred TWh — so `formatEnergy` picks a unit (MWh → GWh → TWh)
 * that keeps the number human-readable, with Australian-English thousands
 * grouping. Period labels match the granularity (a day, a month, a quarter, a
 * year).
 */

import { CalendarDate } from '@internationalized/date';
import { getMonthName, getQuarter } from './date-utils';

export type Granularity = 'day' | 'month' | 'quarter' | 'year';

const AU = 'en-AU';

/** Round to 1 decimal below 100, whole numbers at/above 100, then group. */
function grouped(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded.toLocaleString(AU);
}

/**
 * Format an energy quantity in MWh using an adaptive unit.
 *   < 1 GWh   → "820 MWh"
 *   < 1 TWh   → "559.6 GWh"
 *   otherwise → "204 TWh"
 */
export function formatEnergy(mwh: number): string {
  const abs = Math.abs(mwh);
  if (abs >= 1_000_000) return `${grouped(mwh / 1_000_000)} TWh`;
  if (abs >= 1_000) return `${grouped(mwh / 1_000)} GWh`;
  return `${Math.round(mwh).toLocaleString(AU)} MWh`;
}

/** A proportion in [0,1] as a one-decimal percentage, e.g. 0.578 → "57.8%". */
export function formatPercent(proportion: number): string {
  return `${(proportion * 100).toFixed(1)}%`;
}

/** "20 Jul 2007" — a single day. */
export function formatDayLabel(date: CalendarDate): string {
  return `${date.day} ${getMonthName(date)} ${date.year}`;
}

/** A period label appropriate to the granularity, from its start date. */
export function formatPeriodLabel(granularity: Granularity, start: CalendarDate): string {
  switch (granularity) {
    case 'day':
      return formatDayLabel(start);
    case 'month':
      return `${getMonthName(start)} ${start.year}`;
    case 'quarter':
      return `Q${getQuarter(start)} ${start.year}`;
    case 'year':
      return `${start.year}`;
  }
}
