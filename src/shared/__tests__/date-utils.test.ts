import { elapsedSince, formatCompactAgeFromAEST, getAESTDateTimeString, getDaysBetween, getDayIndex, getDateFromIndex, isLeapYear, networkDayFromInterval, getTodayAEST } from '@/shared/date-utils';
import { CalendarDate, parseAbsolute, today } from '@internationalized/date';

describe('Date Utilities', () => {
  describe('getAESTDateTimeString', () => {
    test('should return current time in AEST format without milliseconds when called without arguments', () => {
      const result = getAESTDateTimeString();
      
      // Check format: YYYY-MM-DDTHH:mm:ss+10:00
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/);
      
      // Should not contain milliseconds
      expect(result).not.toContain('.');
      
      // Should not contain timezone identifier
      expect(result).not.toContain('[');
      expect(result).not.toContain('Australia/Brisbane');
      
      // Should contain the AEST offset
      expect(result).toContain('+10:00');
    });
    
    test('should convert a specific date to AEST format without milliseconds', () => {
      // Test with a known date/time
      const testDate = new Date('2023-07-21T06:30:45.123Z'); // UTC time
      const result = getAESTDateTimeString(testDate);
      
      // Check format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/);
      
      // Should not contain milliseconds
      expect(result).not.toContain('.');
      
      // Should not contain timezone identifier
      expect(result).not.toContain('[');
      expect(result).not.toContain('Australia/Brisbane');
      
      // Should contain the AEST offset
      expect(result).toContain('+10:00');
      
      // The time should be 10 hours ahead of UTC
      // UTC: 2023-07-21T06:30:45
      // AEST: 2023-07-21T16:30:45+10:00
      expect(result).toBe('2023-07-21T16:30:45+10:00');
    });

    test('should handle dates across year boundaries', () => {
      // Test New Year's Eve UTC which becomes New Year's Day in AEST
      const newYearUTC = new Date('2023-12-31T14:30:00.000Z');
      const result = getAESTDateTimeString(newYearUTC);
      
      // UTC 14:30 on Dec 31 = AEST 00:30 on Jan 1
      expect(result).toBe('2024-01-01T00:30:00+10:00');
    });

    test('should handle dates during daylight saving time', () => {
      // Note: Brisbane doesn't observe DST, so it's always +10:00
      const summerDate = new Date('2024-01-15T12:00:00.000Z');
      const winterDate = new Date('2024-07-15T12:00:00.000Z');
      
      const summerResult = getAESTDateTimeString(summerDate);
      const winterResult = getAESTDateTimeString(winterDate);
      
      // Both should have +10:00 offset (no DST in Brisbane)
      expect(summerResult).toContain('+10:00');
      expect(winterResult).toContain('+10:00');
      
      // Verify the times
      expect(summerResult).toBe('2024-01-15T22:00:00+10:00');
      expect(winterResult).toBe('2024-07-15T22:00:00+10:00');
    });

  });

  describe('getDaysBetween', () => {
    test('should calculate days between two dates in the same year', () => {
      const start = new CalendarDate(2024, 1, 1);
      const end = new CalendarDate(2024, 1, 31);
      expect(getDaysBetween(start, end)).toBe(30);
    });

    test('should calculate days between two dates across years', () => {
      const start = new CalendarDate(2023, 12, 31);
      const end = new CalendarDate(2024, 1, 1);
      expect(getDaysBetween(start, end)).toBe(1);
    });

    test('should return negative days when end is before start', () => {
      const start = new CalendarDate(2024, 1, 31);
      const end = new CalendarDate(2024, 1, 1);
      expect(getDaysBetween(start, end)).toBe(-30);
    });

    test('should return 0 for the same date', () => {
      const date = new CalendarDate(2024, 3, 15);
      expect(getDaysBetween(date, date)).toBe(0);
    });

    test('should handle leap years correctly', () => {
      // 2024 is a leap year
      const start = new CalendarDate(2024, 2, 28);
      const end = new CalendarDate(2024, 3, 1);
      expect(getDaysBetween(start, end)).toBe(2); // Feb 29 exists

      // 2023 is not a leap year
      const start2 = new CalendarDate(2023, 2, 28);
      const end2 = new CalendarDate(2023, 3, 1);
      expect(getDaysBetween(start2, end2)).toBe(1); // Feb 29 doesn't exist
    });

    test('should calculate days for a full year correctly', () => {
      const start = new CalendarDate(2024, 1, 1);
      const end = new CalendarDate(2024, 12, 31);
      expect(getDaysBetween(start, end)).toBe(365); // 366 days in leap year minus 1

      const start2 = new CalendarDate(2023, 1, 1);
      const end2 = new CalendarDate(2023, 12, 31);
      expect(getDaysBetween(start2, end2)).toBe(364); // 365 days in regular year minus 1
    });

    test('is DST-safe: exact inverse of CalendarDate.add across a DST boundary', () => {
      // Dec 2006 is AEDT (DST); adding ~19.5yrs lands in Jul 2026 (AEST, no DST).
      // A local-time diff would be an hour short here and Math.floor would drop a
      // day (7131), landing boundary navigation 1 day off the present.
      const start = new CalendarDate(2006, 12, 31);
      for (const days of [7132, 5000, 1234, 366, 90]) {
        expect(getDaysBetween(start, start.add({ days }))).toBe(days);
      }
    });

    test('should handle large date ranges', () => {
      const start = new CalendarDate(2020, 1, 1);
      const end = new CalendarDate(2025, 1, 1);
      // 2020 (leap): 366, 2021: 365, 2022: 365, 2023: 365, 2024 (leap): 366 = 1827 days
      expect(getDaysBetween(start, end)).toBe(1827);
    });
  });

  describe('getDayIndex', () => {
    test('should return 0 for January 1st', () => {
      const date = new CalendarDate(2024, 1, 1);
      expect(getDayIndex(date)).toBe(0);
    });

    test('should return 364 for December 31st in non-leap year', () => {
      const date = new CalendarDate(2023, 12, 31);
      expect(getDayIndex(date)).toBe(364);
    });

    test('should return 365 for December 31st in leap year', () => {
      const date = new CalendarDate(2024, 12, 31);
      expect(getDayIndex(date)).toBe(365);
    });

    test('should handle February 29th in leap year', () => {
      const date = new CalendarDate(2024, 2, 29);
      expect(getDayIndex(date)).toBe(59); // Jan: 31, Feb: 28 days before = 59
    });

    test('should handle mid-year dates correctly', () => {
      const date = new CalendarDate(2024, 7, 1); // July 1st
      // Jan: 31, Feb: 29, Mar: 31, Apr: 30, May: 31, Jun: 30 = 182
      expect(getDayIndex(date)).toBe(182);
    });
  });

  describe('getDateFromIndex', () => {
    test('should return January 1st for index 0', () => {
      const date = getDateFromIndex(2024, 0);
      expect(date.year).toBe(2024);
      expect(date.month).toBe(1);
      expect(date.day).toBe(1);
    });

    test('should return December 31st for index 364 in non-leap year', () => {
      const date = getDateFromIndex(2023, 364);
      expect(date.year).toBe(2023);
      expect(date.month).toBe(12);
      expect(date.day).toBe(31);
    });

    test('should return December 31st for index 365 in leap year', () => {
      const date = getDateFromIndex(2024, 365);
      expect(date.year).toBe(2024);
      expect(date.month).toBe(12);
      expect(date.day).toBe(31);
    });

    test('should return February 29th for index 59 in leap year', () => {
      const date = getDateFromIndex(2024, 59);
      expect(date.year).toBe(2024);
      expect(date.month).toBe(2);
      expect(date.day).toBe(29);
    });

    test('should throw error for invalid index', () => {
      expect(() => getDateFromIndex(2023, 365)).toThrow('Day index 365 is out of range for year 2023 (0-364)');
      expect(() => getDateFromIndex(2024, 366)).toThrow('Day index 366 is out of range for year 2024 (0-365)');
      expect(() => getDateFromIndex(2024, -1)).toThrow('Day index -1 is out of range for year 2024 (0-365)');
    });

    test('should be inverse of getDayIndex', () => {
      const testDates = [
        new CalendarDate(2024, 1, 1),
        new CalendarDate(2024, 2, 29),
        new CalendarDate(2024, 7, 15),
        new CalendarDate(2024, 12, 31),
        new CalendarDate(2023, 6, 15),
        new CalendarDate(2023, 12, 31)
      ];

      testDates.forEach(originalDate => {
        const index = getDayIndex(originalDate);
        const reconstructedDate = getDateFromIndex(originalDate.year, index);
        expect(reconstructedDate.toString()).toBe(originalDate.toString());
      });
    });
  });

  describe('isLeapYear', () => {
    test('should correctly identify leap years', () => {
      expect(isLeapYear(2024)).toBe(true);  // Divisible by 4
      expect(isLeapYear(2000)).toBe(true);  // Divisible by 400
      expect(isLeapYear(2020)).toBe(true);  // Divisible by 4
    });

    test('should correctly identify non-leap years', () => {
      expect(isLeapYear(2023)).toBe(false); // Not divisible by 4
      expect(isLeapYear(1900)).toBe(false); // Divisible by 100 but not 400
      expect(isLeapYear(2100)).toBe(false); // Divisible by 100 but not 400
    });
  });

  describe('networkDayFromInterval', () => {
    // The OpenElectricity client returns each daily bucket as the instant of
    // network-local midnight: NEM = 00:00 AEST (UTC+10) → 14:00Z the prior day;
    // WEM = 00:00 AWST (UTC+8) → 16:00Z the prior day.

    test('maps a NEM winter interval to its AEST day', () => {
      const date = networkDayFromInterval(new Date('2024-05-31T14:00:00.000Z'), 'NEM');
      expect(date.year).toBe(2024);
      expect(date.month).toBe(6);
      expect(date.day).toBe(1);
    });

    test('NEM is fixed UTC+10 year-round (no daylight saving)', () => {
      // Summer (would-be AEDT season) still anchors at 14:00Z, not 13:00Z.
      const date = networkDayFromInterval(new Date('2023-12-31T14:00:00.000Z'), 'NEM');
      expect(date.year).toBe(2024);
      expect(date.month).toBe(1);
      expect(date.day).toBe(1);
    });

    test('maps a WEM interval to its AWST (UTC+8) day', () => {
      const date = networkDayFromInterval(new Date('2023-12-31T16:00:00.000Z'), 'WEM');
      expect(date.year).toBe(2024);
      expect(date.month).toBe(1);
      expect(date.day).toBe(1);
    });

    test('handles the year boundary', () => {
      const date = networkDayFromInterval(new Date('2024-12-31T14:00:00.000Z'), 'NEM');
      expect(date.year).toBe(2025);
      expect(date.month).toBe(1);
      expect(date.day).toBe(1);
    });

    test('handles the leap day', () => {
      const date = networkDayFromInterval(new Date('2024-02-28T14:00:00.000Z'), 'NEM');
      expect(date.year).toBe(2024);
      expect(date.month).toBe(2);
      expect(date.day).toBe(29);
    });

    test('unknown networks fall back to NEM (Brisbane) time', () => {
      const date = networkDayFromInterval(new Date('2024-05-31T14:00:00.000Z'), 'ZZZ');
      expect(date.year).toBe(2024);
      expect(date.month).toBe(6);
      expect(date.day).toBe(1);
    });
  });

  describe('getTodayAEST', () => {
    test('should return a CalendarDate object', () => {
      const result = getTodayAEST();
      expect(result).toBeInstanceOf(CalendarDate);
    });

    test('should return today in AEST timezone', () => {
      const result = getTodayAEST();
      const expectedToday = today('Australia/Brisbane');
      
      expect(result.year).toBe(expectedToday.year);
      expect(result.month).toBe(expectedToday.month);
      expect(result.day).toBe(expectedToday.day);
    });

    test('should match the date part of a formatted AEST datetime', () => {
      const todayAEST = getTodayAEST();
      const nowAEST = getAESTDateTimeString();
      
      // Extract date part from the datetime string
      const datePart = nowAEST.split('T')[0];
      const [year, month, day] = datePart.split('-').map(Number);
      
      expect(todayAEST.year).toBe(year);
      expect(todayAEST.month).toBe(month);
      expect(todayAEST.day).toBe(day);
    });

    test('should be consistent across multiple calls', () => {
      const result1 = getTodayAEST();
      const result2 = getTodayAEST();

      expect(result1.toString()).toBe(result2.toString());
    });
  });

  // The age column on /diagnostics. Width matters as much as accuracy: 30 rows
  // are read by scanning, so the format is at most two units and the second is
  // dropped when it is zero.
  describe('formatCompactAgeFromAEST', () => {
    const at = (iso: string) => parseAbsolute(iso, 'Australia/Brisbane');
    const reference = at('2026-08-15T12:00:00+10:00');

    const ago = (seconds: number): string | null =>
      formatCompactAgeFromAEST(reference.subtract({ seconds }).toAbsoluteString(), reference);

    const between = (fromIso: string, toIso: string): string | null =>
      formatCompactAgeFromAEST(at(fromIso).toAbsoluteString(), at(toIso));

    test.each([
      [30, 'just now'],
      [60, '1m ago'],
      [54 * 60, '54m ago'],
      [3600, '1h ago'],
      [3600 + 59 * 60, '1h 59m ago'],
      [7 * 86400 + 4 * 3600, '7d 4h ago'],
    ])('renders %i seconds as "%s"', (seconds, expected) => {
      expect(ago(seconds)).toBe(expected);
    });

    test('drops a zero second unit rather than padding it', () => {
      expect(ago(3 * 86400)).toBe('3d ago');
      expect(ago(2 * 3600)).toBe('2h ago');
    });

    test('truncates rather than rounds, so 1h 59m never becomes 1h 60m', () => {
      for (let seconds = 3600; seconds < 3 * 3600; seconds += 7) {
        expect(ago(seconds)).not.toMatch(/ 60m ago$/);
      }
    });

    // The display only ever shows two ADJACENT units, so a year-old file reads
    // "1y ago" even when there is a stray day on the end: at that magnitude the
    // day is noise, and skipping months to show it would read oddly.
    test('drops the smaller unit when the adjacent one is zero', () => {
      expect(between('2026-08-15T12:00:00+10:00', '2027-08-16T12:00:00+10:00')).toBe('1y ago');
      expect(between('2024-05-15T12:00:00+10:00', '2026-08-15T12:00:00+10:00')).toBe('2y 3mon ago');
    });

    test('reads a future stamp as "just now" rather than a negative age', () => {
      expect(formatCompactAgeFromAEST(reference.add({ days: 1 }).toAbsoluteString(), reference))
        .toBe('just now');
    });

    test('returns null for an unparseable stamp', () => {
      expect(formatCompactAgeFromAEST('not a date')).toBeNull();
    });
  });

  // The whole point of counting in the calendar rather than dividing by an
  // average: months are 28-31 days and years are 365 or 366, so "1mon" has to
  // mean a real month or the readout is simply wrong.
  describe('elapsedSince', () => {
    const at = (iso: string) => parseAbsolute(iso, 'Australia/Brisbane');
    const parts = (fromIso: string, toIso: string) => elapsedSince(at(fromIso), at(toIso));

    test('one calendar month is one month however many days that month has', () => {
      // February 2027 has 28 days, July has 31. Both are exactly one month, and
      // a fixed 30-day block is neither.
      expect(parts('2027-02-01T09:00:00+10:00', '2027-03-01T09:00:00+10:00')).toMatchObject({
        months: 1, days: 0,
      });
      expect(parts('2026-07-01T09:00:00+10:00', '2026-08-01T09:00:00+10:00')).toMatchObject({
        months: 1, days: 0,
      });
      expect(parts('2026-07-01T09:00:00+10:00', '2026-07-31T09:00:00+10:00')).toMatchObject({
        months: 0, days: 30,
      });
    });

    test('does not claim a month before the day-of-month is reached', () => {
      expect(parts('2027-02-01T09:00:00+10:00', '2027-02-28T09:00:00+10:00')).toMatchObject({
        months: 0, days: 27,
      });
      expect(parts('2026-01-31T12:00:00+10:00', '2026-02-28T11:00:00+10:00')).toMatchObject({
        months: 0, days: 27, hours: 23,
      });
    });

    test('an exact year is one year with nothing left over, leap or not', () => {
      // 2027→2028 spans 29 February: 366 days, still exactly a year.
      expect(parts('2027-08-15T12:00:00+10:00', '2028-08-15T12:00:00+10:00')).toMatchObject({
        years: 1, months: 0, days: 0,
      });
      // 2026→2027 is 365 days, also exactly a year. A fixed divisor cannot make
      // both of these come out right.
      expect(parts('2026-08-15T12:00:00+10:00', '2027-08-15T12:00:00+10:00')).toMatchObject({
        years: 1, months: 0, days: 0,
      });
      // 366 days from a non-leap start therefore has a day left over.
      expect(parts('2026-08-15T12:00:00+10:00', '2027-08-16T12:00:00+10:00')).toMatchObject({
        years: 1, months: 0, days: 1,
      });
    });

    test('handles the end of a long month landing in a short one', () => {
      // 31 January + 1 month clamps to 28 February, and that is a whole month.
      expect(parts('2026-01-31T12:00:00+10:00', '2026-02-28T12:00:00+10:00')).toMatchObject({
        months: 1, days: 0,
      });
    });

    test('never leaves a remainder that should have carried', () => {
      const from = at('2020-01-31T12:00:00+10:00');
      for (let days = 0; days < 800; days += 1) {
        const p = elapsedSince(from, from.add({ days }));
        expect(p.months, `day ${days}`).toBeLessThan(12);
        expect(p.hours, `day ${days}`).toBeLessThan(24);
        expect(p.minutes, `day ${days}`).toBeLessThan(60);
        expect(p.days, `day ${days}`).toBeGreaterThanOrEqual(0);
      }
    });
  });
});