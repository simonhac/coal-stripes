/**
 * The alive-span rules that decide whether a null day reads as "not yet
 * commissioned" (page background) or "no data" (pale blue).
 *
 * The cases that matter are the ones a single year of values cannot answer on
 * its own: a gap straddling New Year, and a unit missing for a whole year.
 */
import { aliveSpan, classifyNull, lifecycleBounds } from '@/shared/data-gaps';

const YEAR_START = '2000-01-01';
const DAYS = 366; // 2000 is a leap year

/** A year of nulls with data on [from, to] inclusive. */
function series(from: number, to: number, length = DAYS): (number | null)[] {
  return Array.from({ length }, (_, i) => (i >= from && i <= to ? 50 : null));
}

describe('aliveSpan', () => {
  it('infers the span from the values when given no bounds', () => {
    expect(aliveSpan(series(10, 20))).toEqual({ first: 10, last: 20 });
  });

  it('reports an all-null series as never alive', () => {
    expect(aliveSpan(Array(DAYS).fill(null))).toEqual({ first: -1, last: -1 });
  });

  it('widens the start when the unit was commissioned before the window', () => {
    // LD01: missing 1999-10-29 → 2000-03-29, so the 2000 slice starts with 89
    // nulls. Without bounds those read as "not yet commissioned"; with them the
    // span opens at day 0 and they are correctly an interior gap.
    const data = series(89, DAYS - 1);
    expect(aliveSpan(data).first).toBe(89);
    expect(classifyNull(0, aliveSpan(data))).toBe('pre-commission');

    const widened = aliveSpan(data, { firstIndex: 0, lastIndex: DAYS - 1 });
    expect(widened.first).toBe(0);
    expect(classifyNull(0, widened)).toBe('interior-gap');
  });

  it('never lets metadata narrow an observed span', () => {
    // MM4's data_first_seen claims 2000-02-28 when readings exist from
    // 1999-01-06; trusting it would hide the very gap we are trying to show.
    const data = series(5, 100);
    expect(aliveSpan(data, { firstIndex: 58 }).first).toBe(5);
    expect(aliveSpan(data, { lastIndex: 40 }).last).toBe(100);
  });

  it('marks a whole missing year as a gap when the unit was alive throughout', () => {
    // Muja 1 in 2009: five years with no data at all, mid-life. Every day is an
    // interior gap, not a blank year.
    const span = aliveSpan(Array(DAYS).fill(null), { firstIndex: 0, lastIndex: DAYS - 1 });
    expect(classifyNull(0, span)).toBe('interior-gap');
    expect(classifyNull(DAYS - 1, span)).toBe('interior-gap');
  });

  it('keeps a year before commissioning blank', () => {
    const span = aliveSpan(Array(DAYS).fill(null), { firstIndex: DAYS, lastIndex: DAYS - 1 });
    expect(classifyNull(0, span)).toBe('pre-commission');
    expect(classifyNull(DAYS - 1, span)).toBe('pre-commission');
  });
});

describe('lifecycleBounds', () => {
  it('clamps a date before the window to the first day', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, '1971-01-01', null).firstIndex).toBe(0);
  });

  it('clamps a date after the window past the last day, so the year is all pre-commission', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, '2003-06-01', null).firstIndex).toBe(DAYS);
  });

  it('indexes a date inside the window', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, '2000-03-01', null).firstIndex).toBe(60);
    expect(lifecycleBounds(YEAR_START, DAYS, null, '2000-03-01').lastIndex).toBe(60);
  });

  it('clamps a closing date after the window to the last day', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, null, '2026-01-01').lastIndex).toBe(DAYS - 1);
  });

  it('clamps a closing date before the window to -1', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, null, '1995-01-01').lastIndex).toBe(-1);
  });

  it('omits a bound it was given no date for', () => {
    expect(lifecycleBounds(YEAR_START, DAYS, null, null)).toEqual({});
  });
});
