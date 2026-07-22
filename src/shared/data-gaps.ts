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
 */

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

export function aliveSpan(data: (number | null)[]): AliveSpan {
  return { first: firstDataDayIndex(data), last: lastDataDayIndex(data) };
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
