/**
 * Classifying "no data" (null) days by their position in a unit's series.
 *
 * A generating unit's daily series is bounded by the days it was alive: the
 * first day it ever reported data (commissioning) and the last (its final
 * reading before retirement, or the current data frontier for a live unit). A
 * null day is interpreted differently depending on where it sits:
 *
 *   • before the first data day — not yet commissioned ("pre-commission" end)
 *   • after the last data day — retired / not yet collected ("post-retirement
 *     end"); note the server emits 0 (not null) for a decommissioned unit's
 *     post-shutdown days, so a genuine shutdown reads as 0, not an end
 *   • anywhere in between — the unit was alive but the reading is MISSING
 *     ("interior-gap"): a genuine hole in the data
 *
 * This is the single definition of that distinction, shared by the canvas
 * stripe renderer (which colours pre-commission ends as page background and
 * everything else null as pale blue, per single-year semantics) and the
 * server-side stats aggregation (which counts interior gaps as holes across the
 * whole 1999→now history).
 *
 * Inferring the span from the values alone is only correct when the values span
 * the unit's whole life. A single-year tile does not: the first data day *in
 * that year* is not commissioning if the unit was simply missing over New Year.
 * LD01 was absent 1999-10-29 → 2000-03-29, and reading its span from the 2000
 * slice alone called the first 89 days "not yet commissioned" for a unit that
 * had run since 1971. So callers holding a window rather than a whole history
 * pass `bounds` derived from OpenElectricity's unit metadata (see
 * lifecycleBounds); those bounds may only ever WIDEN the observed span, never
 * narrow it, because the metadata is not always right either — `data_first_seen`
 * reports the start of the later contiguous run for units with early gaps (MM4
 * claims 2000-02-28 when data exists from 1999-01-06), and trusting it to narrow
 * would hide the very gaps this distinction exists to show.
 */

import { parseDate } from '@internationalized/date';
import { getDaysBetween } from './date-utils';

/** 0-based index of the last non-null day in a series; -1 if all null. */
export function lastDataDayIndex(data: (number | null)[]): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] !== null) return i;
  }
  return -1;
}

/** 0-based index of the first non-null day in a series; -1 if all null. */
export function firstDataDayIndex(data: (number | null)[]): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== null) return i;
  }
  return -1;
}

/**
 * The span of days a unit was alive: the first and last indices with data.
 * `first` is -1 (and `last` -1) when the unit has no data at all.
 */
export interface AliveSpan {
  first: number;
  last: number;
}

/**
 * Externally-known bounds on a unit's life, as indices into the same series.
 * Either may be omitted; an omitted bound leaves that end inferred from the
 * values. Build them with lifecycleBounds() rather than by hand.
 */
export interface LifecycleBounds {
  firstIndex?: number;
  lastIndex?: number;
}

export function aliveSpan(data: (number | null)[], bounds?: LifecycleBounds): AliveSpan {
  const observedFirst = firstDataDayIndex(data);
  const observedLast = lastDataDayIndex(data);

  // Widen only: take the earlier start and the later end of what the metadata
  // claims and what the values actually show.
  const first =
    bounds?.firstIndex === undefined
      ? observedFirst
      : observedFirst < 0
        ? bounds.firstIndex
        : Math.min(bounds.firstIndex, observedFirst);
  const last =
    bounds?.lastIndex === undefined
      ? observedLast
      : observedLast < 0
        ? bounds.lastIndex
        : Math.max(bounds.lastIndex, observedLast);

  return { first, last };
}

/**
 * Turn a unit's lifecycle dates into bounds on a window of daily values.
 *
 * `windowStart` is the window's first day (a `UnitHistoryDTO.start`); `length`
 * its number of days. A date falling outside the window is clamped so the
 * classification still reads correctly: a unit commissioned before the window
 * starts gets index 0 (nothing in the window is pre-commission), one
 * commissioned after it ends gets `length` (all of it is), and symmetrically
 * for the closing bound.
 */
export function lifecycleBounds(
  windowStart: string,
  length: number,
  commenced?: string | null,
  lastSeen?: string | null
): LifecycleBounds {
  const bounds: LifecycleBounds = {};
  const start = parseDate(windowStart);

  if (commenced) {
    const offset = getDaysBetween(start, parseDate(commenced));
    bounds.firstIndex = Math.min(Math.max(offset, 0), length);
  }
  if (lastSeen) {
    const offset = getDaysBetween(start, parseDate(lastSeen));
    bounds.lastIndex = Math.min(Math.max(offset, -1), length - 1);
  }

  return bounds;
}

export type NullPosition = 'pre-commission' | 'post-retirement-end' | 'interior-gap';

/**
 * Classify a null day by its position relative to the unit's alive span.
 * Precondition: the day at `index` is null. A unit with no data at all
 * classifies every day as 'pre-commission' (it was never alive).
 */
export function classifyNull(index: number, span: AliveSpan): NullPosition {
  if (span.first < 0 || index < span.first) return 'pre-commission';
  if (index > span.last) return 'post-retirement-end';
  return 'interior-gap';
}
