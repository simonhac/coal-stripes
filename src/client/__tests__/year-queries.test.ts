import { CalendarDate } from '@internationalized/date';
import * as dateUtils from '@/shared/date-utils';
import { getEarliestYear, getLatestYear, isValidYear, yearQueryOptions } from '../year-queries';
import { YEAR_CACHE_TIERS } from '@/shared/config';

// Mock the date utilities so "today" is deterministic
jest.mock('@/shared/date-utils', () => ({
  ...jest.requireActual('@/shared/date-utils'),
  getTodayAEST: jest.fn()
}));

const mockGetTodayAEST = dateUtils.getTodayAEST as jest.MockedFunction<typeof dateUtils.getTodayAEST>;

describe('year-queries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
  });

  describe('year bounds', () => {
    it('should return 1999 as the earliest year (start of facility-level data)', () => {
      expect(getEarliestYear()).toBe(1999);
    });

    it('should return the current year as the latest year', () => {
      expect(getLatestYear()).toBe(2024);
    });

    it('should update when the year changes', () => {
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2027, 6, 1));
      expect(getLatestYear()).toBe(2027);
    });

    it('should accept valid years', () => {
      expect(isValidYear(1999)).toBe(true);
      expect(isValidYear(2005)).toBe(true);
      expect(isValidYear(2015)).toBe(true);
      expect(isValidYear(2024)).toBe(true);
    });

    it('should reject years before 1999', () => {
      expect(isValidYear(1998)).toBe(false);
      expect(isValidYear(1990)).toBe(false);
    });

    it('should reject years after the current year', () => {
      expect(isValidYear(2025)).toBe(false);
      expect(isValidYear(2030)).toBe(false);
    });

    it('should handle year boundary on Dec 31', () => {
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 12, 31));
      expect(isValidYear(2024)).toBe(true);
      expect(isValidYear(2025)).toBe(false);
    });

    it('should handle year boundary on Jan 1 (latest data day is yesterday)', () => {
      // On New Year's Day the latest data is 31 Dec, so the new year is not
      // yet a valid data year.
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 1));
      expect(isValidYear(2024)).toBe(true);
      expect(isValidYear(2025)).toBe(false);

      // A day later the new year has its first day of data.
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 2));
      expect(isValidYear(2025)).toBe(true);
    });
  });

  describe('yearQueryOptions', () => {
    it('keys queries by mode and year', () => {
      expect(yearQueryOptions('full', 2023).queryKey).toEqual(['capFacYear', 'full', 2023]);
      expect(yearQueryOptions('current', 2023).queryKey).toEqual(['capFacYear', 'current', 2023]);
    });

    it('gives the current year the short (hourly) staleTime', () => {
      expect(yearQueryOptions('full', 2024).staleTime).toBe(
        YEAR_CACHE_TIERS.current.revalidateSeconds * 1000
      );
    });

    it('gives recent past years the daily staleTime (data is subject to revision)', () => {
      expect(yearQueryOptions('full', 2023).staleTime).toBe(
        YEAR_CACHE_TIERS.recent.revalidateSeconds * 1000
      );
    });

    it('gives archive years a finite weekly staleTime — never Infinity', () => {
      expect(yearQueryOptions('full', 2010).staleTime).toBe(
        YEAR_CACHE_TIERS.archive.revalidateSeconds * 1000
      );
    });

    it('disables structural sharing (canvas-bearing cache values)', () => {
      expect(yearQueryOptions('full', 2023).structuralSharing).toBe(false);
    });
  });
});
