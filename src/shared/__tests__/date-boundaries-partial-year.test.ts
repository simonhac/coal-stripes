import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { CalendarDate } from '@internationalized/date';
import { getDateBoundaries } from '../date-boundaries';
import { getTodayAEST } from '../date-utils';

/**
 * The real earliest boundary is a PARTIAL year: OpenElectricity's record starts
 * on 7 December 1998, not 1 January. This file pins the arithmetic that falls
 * out of that, separately from date-boundaries.test.ts because the config mock
 * is module-level and each file can only hold one.
 *
 * Its sibling uses a 1 January start, which is the case that used to be true and
 * which quietly hid the fact that earliestDataEndDay landed on a year boundary
 * only by coincidence (1999 is not a leap year, so 1999-01-01 + 364 = 1999-12-31).
 */

vi.mock('../date-utils', async () => {
  const actual = await vi.importActual<typeof import('../date-utils')>('../date-utils');
  return { ...actual, getTodayAEST: vi.fn() };
});

vi.mock('../config', async () => {
  const { CalendarDate } =
    await vi.importActual<typeof import('@internationalized/date')>('@internationalized/date');
  return {
    DATE_BOUNDARIES: {
      EARLIEST_START_DATE: new CalendarDate(1998, 12, 7),
      TILE_WIDTH: 365,
      DISPLAY_SLOP_MONTHS: 9
    }
  };
});

describe('date-boundaries with a partial earliest year', () => {
  const mockTodayAEST = getTodayAEST as MockedFunction<typeof getTodayAEST>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTodayAEST.mockReturnValue(new CalendarDate(2026, 8, 15));
  });

  it('starts on 7 December 1998', () => {
    expect(getDateBoundaries().earliestDataDay.toString()).toBe('1998-12-07');
  });

  it('puts the first valid end date mid-December, NOT on a year boundary', () => {
    // The load-bearing assertion: offset 0 spans two calendar years. Anything
    // that assumes the leftmost window is a whole calendar year breaks here.
    expect(getDateBoundaries().earliestDataEndDay.toString()).toBe('1999-12-06');
  });

  it('round-trips a full tile width between the two earliest bounds', () => {
    const { earliestDataDay, earliestDataEndDay } = getDateBoundaries();
    expect(earliestDataEndDay.subtract({ days: 364 }).toString()).toBe(
      earliestDataDay.toString()
    );
  });

  it('reports 1998 as the earliest data year even though it holds 25 days', () => {
    expect(getDateBoundaries().earliestDataYear).toBe(1998);
  });

  it('treats offset 0 as in bounds and anything left of it as overstep', () => {
    const boundaries = getDateBoundaries();
    expect(boundaries.calculateOverstep(0)).toBeNull();
    expect(boundaries.calculateOverstep(-1)).toBe(1);
    expect(boundaries.calculateOverstep(-60)).toBe(60);
  });

  it('clamps a date before the record to 7 December 1998', () => {
    const boundaries = getDateBoundaries();
    expect(boundaries.isWithinDataBounds(new CalendarDate(1998, 12, 6))).toBe(false);
    expect(boundaries.isWithinDataBounds(new CalendarDate(1998, 12, 7))).toBe(true);
    expect(boundaries.clampToDataBounds(new CalendarDate(1998, 1, 1)).toString()).toBe(
      '1998-12-07'
    );
  });
});
