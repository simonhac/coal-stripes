import { CalendarDate } from '@internationalized/date';
import { getDateBoundaries } from '../date-boundaries';
import { getTodayAEST } from '../date-utils';

// Mock the date-utils module
jest.mock('../date-utils', () => ({
  getTodayAEST: jest.fn()
}));

// Mock the config module
jest.mock('../config', () => {
  const { CalendarDate } = jest.requireActual('@internationalized/date');
  return {
    DATE_BOUNDARIES: {
      EARLIEST_START_DATE: new CalendarDate(2006, 1, 1),
      TILE_WIDTH: 365,
      DISPLAY_SLOP_MONTHS: 6
    }
  };
});

describe('date-boundaries', () => {
  const mockTodayAEST = getTodayAEST as jest.MockedFunction<typeof getTodayAEST>;
  
  beforeEach(() => {
    // Set a consistent "today" for tests - 15 March 2024
    mockTodayAEST.mockReturnValue(new CalendarDate(2024, 3, 15));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getDateBoundaries', () => {
    it('should calculate correct data boundaries', () => {
      const boundaries = getDateBoundaries();
      
      // Check earliest data day
      expect(boundaries.earliestDataDay.toString()).toBe('2006-01-01');
      
      // Check earliest data end day (364 days after start)
      expect(boundaries.earliestDataEndDay.toString()).toBe('2006-12-31');
      
      // Check latest data day (yesterday)
      expect(boundaries.latestDataDay.toString()).toBe('2024-03-14');
      
      // Check year boundaries
      expect(boundaries.earliestDataYear).toBe(2006);
      expect(boundaries.latestDataYear).toBe(2024);
    });

    it('should calculate correct display boundaries with 6 month buffer', () => {
      const boundaries = getDateBoundaries();
      
      // Earliest display day should be 6 months before earliest data day
      // 2006-01-01 minus 6 months = 2005-07-01
      expect(boundaries.earliestDisplayDay.toString()).toBe('2005-07-01');
      
      // Latest display day should be 6 months after latest data day
      expect(boundaries.latestDisplayDay.toString()).toBe('2024-09-14');
    });

    it('should handle year boundaries correctly when today changes', () => {
      // Test year transition
      mockTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 2));
      const boundaries = getDateBoundaries();
      
      expect(boundaries.latestDataDay.toString()).toBe('2025-01-01');
      expect(boundaries.latestDataYear).toBe(2025);
      expect(boundaries.latestDisplayDay.toString()).toBe('2025-07-01');
    });
  });

  describe('isWithinDataBounds', () => {
    it('should return true for dates within data bounds', () => {
      const boundaries = getDateBoundaries();
      
      // Test earliest boundary
      expect(boundaries.isWithinDataBounds(new CalendarDate(2006, 1, 1))).toBe(true);
      
      // Test latest boundary
      expect(boundaries.isWithinDataBounds(new CalendarDate(2024, 3, 14))).toBe(true);
      
      // Test middle date
      expect(boundaries.isWithinDataBounds(new CalendarDate(2015, 6, 15))).toBe(true);
    });

    it('should return false for dates outside data bounds', () => {
      const boundaries = getDateBoundaries();
      
      // Before earliest
      expect(boundaries.isWithinDataBounds(new CalendarDate(2005, 12, 31))).toBe(false);
      
      // After latest (today or future)
      expect(boundaries.isWithinDataBounds(new CalendarDate(2024, 3, 15))).toBe(false);
      expect(boundaries.isWithinDataBounds(new CalendarDate(2024, 3, 16))).toBe(false);
    });
  });

  describe('isWithinDisplayBounds', () => {
    it('should return true for dates within display bounds', () => {
      const boundaries = getDateBoundaries();
      
      // Test earliest display boundary
      expect(boundaries.isWithinDisplayBounds(new CalendarDate(2005, 7, 1))).toBe(true);
      
      // Test latest display boundary  
      expect(boundaries.isWithinDisplayBounds(new CalendarDate(2024, 9, 14))).toBe(true);
      
      // Test data boundaries (should be within display bounds)
      expect(boundaries.isWithinDisplayBounds(boundaries.earliestDataDay)).toBe(true);
      expect(boundaries.isWithinDisplayBounds(boundaries.latestDataDay)).toBe(true);
    });

    it('should return false for dates outside display bounds', () => {
      const boundaries = getDateBoundaries();
      
      // Before earliest display
      expect(boundaries.isWithinDisplayBounds(new CalendarDate(2005, 6, 30))).toBe(false);
      
      // After latest display
      expect(boundaries.isWithinDisplayBounds(new CalendarDate(2024, 9, 15))).toBe(false);
    });
  });

  describe('clampToDataBounds', () => {
    it('should return the same date if within bounds', () => {
      const boundaries = getDateBoundaries();
      const validDate = new CalendarDate(2015, 6, 15);
      
      expect(boundaries.clampToDataBounds(validDate)).toBe(validDate);
    });

    it('should clamp to earliest data day if before bounds', () => {
      const boundaries = getDateBoundaries();
      const earlyDate = new CalendarDate(2005, 12, 31);
      
      const clamped = boundaries.clampToDataBounds(earlyDate);
      expect(clamped.toString()).toBe('2006-01-01');
    });

    it('should clamp to latest data day if after bounds', () => {
      const boundaries = getDateBoundaries();
      const futureDate = new CalendarDate(2024, 3, 15); // Today
      
      const clamped = boundaries.clampToDataBounds(futureDate);
      expect(clamped.toString()).toBe('2024-03-14'); // Yesterday
    });
  });

  describe('clampToDisplayBounds', () => {
    it('should return the same date if within display bounds', () => {
      const boundaries = getDateBoundaries();
      const validDate = new CalendarDate(2015, 6, 15);
      
      expect(boundaries.clampToDisplayBounds(validDate)).toBe(validDate);
    });

    it('should clamp to earliest display day if before bounds', () => {
      const boundaries = getDateBoundaries();
      const earlyDate = new CalendarDate(2005, 6, 30);
      
      const clamped = boundaries.clampToDisplayBounds(earlyDate);
      expect(clamped.toString()).toBe('2005-07-01');
    });

    it('should clamp to latest display day if after bounds', () => {
      const boundaries = getDateBoundaries();
      const futureDate = new CalendarDate(2024, 9, 15);
      
      const clamped = boundaries.clampToDisplayBounds(futureDate);
      expect(clamped.toString()).toBe('2024-09-14');
    });
  });

  describe('boundary relationships', () => {
    it('should ensure display bounds properly encompass data bounds', () => {
      const boundaries = getDateBoundaries();
      
      // Display bounds should be wider than data bounds
      // Earliest display should be before earliest data
      expect(boundaries.earliestDisplayDay.compare(boundaries.earliestDataDay)).toBeLessThan(0);
      
      // Latest display should be after latest data
      expect(boundaries.latestDisplayDay.compare(boundaries.latestDataDay)).toBeGreaterThan(0);
    });

    it('should maintain consistent buffer size', () => {
      const boundaries = getDateBoundaries();
      
      // The display buffer should be exactly 6 months on each side
      const earliestBuffer = boundaries.earliestDataDay.subtract({ months: 6 });
      expect(boundaries.earliestDisplayDay.toString()).toBe(earliestBuffer.toString());
      
      const latestBuffer = boundaries.latestDataDay.add({ months: 6 });
      expect(boundaries.latestDisplayDay.toString()).toBe(latestBuffer.toString());
    });
  });
});