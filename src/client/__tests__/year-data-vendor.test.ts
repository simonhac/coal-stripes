import { YearDataVendor } from '../year-data-vendor';
import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { MockCanvas } from './helpers/mock-canvas';
import { CalendarDate } from '@internationalized/date';
import * as dateUtils from '@/shared/date-utils';

global.OffscreenCanvas = MockCanvas as any;

// Mock fetch
global.fetch = jest.fn();

// Mock the date utilities
jest.mock('@/shared/date-utils', () => ({
  ...jest.requireActual('@/shared/date-utils'),
  getTodayAEST: jest.fn()
}));

// Keep the real config (CACHE_CONFIG, CLIENT_REQUEST_QUEUE_CONFIG, …) and only
// override the DATE_BOUNDARIES this suite pins for deterministic assertions.
jest.mock('@/shared/config', () => {
  const actual = jest.requireActual('@/shared/config');
  const { CalendarDate } = jest.requireActual('@internationalized/date');
  return {
    ...actual,
    DATE_BOUNDARIES: {
      ...actual.DATE_BOUNDARIES,
      EARLIEST_START_DATE: new CalendarDate(2006, 1, 1),
      DISPLAY_SLOP_MONTHS: 6
    }
  };
});

describe('YearDataVendor', () => {
  let vendor: YearDataVendor;
  const mockGetTodayAEST = dateUtils.getTodayAEST as jest.MockedFunction<typeof dateUtils.getTodayAEST>;
  
  
  beforeEach(() => {
    vendor = new YearDataVendor(3, { maxRetries: 0 }); // Small cache for testing, no retries
    jest.clearAllMocks();
    // Default to 2024 for tests
    mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
  });
  
  afterEach(() => {
    // Clear any pending operations
    vendor.clear();
  });

  const mockYearData = (year: number): GeneratingUnitCapFacHistoryDTO => ({
    type: 'capacity_factors',
    version: '1.0',
    created_at: new Date().toISOString(),
    data: [
      {
        network: 'TEST',
        region: 'TEST1',
        data_type: 'capacity_factor',
        units: 'MW',
        capacity: 100,
        duid: 'TEST01',
        facility_code: 'TESTFAC',
        facility_name: 'Test Facility',
        fueltech: 'black_coal',
        history: {
          data: Array(365).fill(50),
          start: `${year}-01-01`,
          last: `${year}-12-31`,
          interval: '1d'
        }
      }
    ]
  });

  describe('requestYear', () => {
    it('should fetch data from server when not cached', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      const result = await vendor.requestYear(2023);
      
      expect(result.year).toBe(2023);
      expect(result.data).toEqual(mockData);
      expect(result.facilityTiles.size).toBe(1);
      expect(result.facilityTiles.has('TESTFAC')).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('/api/capacity-factors?year=2023');
    });

    it('should return cached data immediately', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      // First request - fetches from server
      await vendor.requestYear(2023);
      
      // Second request - should return from cache
      jest.clearAllMocks();
      const result = await vendor.requestYear(2023);
      
      expect(result.year).toBe(2023);
      expect(result.data).toEqual(mockData);
      expect(result.facilityTiles.size).toBe(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should deduplicate concurrent requests', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      // Make three concurrent requests
      const promises = [
        vendor.requestYear(2023),
        vendor.requestYear(2023),
        vendor.requestYear(2023)
      ];

      const results = await Promise.all(promises);
      
      // All should get the same data
      expect(results[0].year).toBe(2023);
      expect(results[0].data).toEqual(mockData);
      expect(results[1].data).toEqual(mockData);
      expect(results[2].data).toEqual(mockData);
      
      // But fetch should only be called once
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should handle fetch errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      await expect(vendor.requestYear(2023)).rejects.toThrow('Network error');
    });

    it('should handle HTTP errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      await expect(vendor.requestYear(2023)).rejects.toThrow('HTTP 404: Not Found');
    });
  });

  describe('hasYear', () => {
    it('should return false for uncached years', () => {
      expect(vendor.hasYear(2023)).toBe(false);
    });

    it('should return true for cached years', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      await vendor.requestYear(2023);
      
      expect(vendor.hasYear(2023)).toBe(true);
    });
  });

  describe('getCacheStats', () => {
    it('should return empty stats initially', () => {
      const stats = vendor.getCacheStats();
      
      expect(stats.numItems).toBe(0);
      expect(stats.totalKB).toBe(0);
      expect(stats.labels).toEqual([]);
      expect(stats.activeRequestsWithRetries).toEqual([]);
      expect(stats.queuedLabels).toEqual([]);
    });

    it('should track cached items', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      await vendor.requestYear(2023);
      
      const stats = vendor.getCacheStats();
      expect(stats.numItems).toBe(1);
      expect(stats.labels).toContain('2023');
      expect(stats.totalKB).toBeGreaterThan(0);
    });

    it('should track pending requests', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: async () => mockData
        }), 100))
      );

      // Start request but don't await initially
      const promise = vendor.requestYear(2023);
      
      // Give it a moment to start processing
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const stats = vendor.getCacheStats();
      expect(stats.activeRequestsWithRetries.map(r => r.label)).toContain('2023');
      
      // Clean up - wait for the request to complete
      await promise;
    });
  });

  describe('clear', () => {
    it('should clear cached data', async () => {
      const mockData = mockYearData(2023);
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData
      });

      await vendor.requestYear(2023);
      expect(vendor.hasYear(2023)).toBe(true);
      
      vendor.clear();
      
      expect(vendor.hasYear(2023)).toBe(false);
      expect(vendor.getCacheStats().numItems).toBe(0);
    });

    it('should cancel pending requests', async () => {
      const mockData = mockYearData(2023);
      
      // Create a vendor with single concurrent request to ensure requests queue up
      const testVendor = new YearDataVendor(3, { 
        maxRetries: 0,
        maxConcurrent: 1,
        minInterval: 10
      });
      
      // First request will start immediately and block the queue
      (global.fetch as jest.Mock).mockImplementationOnce(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: async () => mockData
        }), 200))
      );
      
      // Second request should be queued
      (global.fetch as jest.Mock).mockImplementationOnce(() => 
        new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: async () => mockYearData(2024)
        }), 100))
      );

      // Start two requests
      const promise1 = testVendor.requestYear(2023);
      const promise2 = testVendor.requestYear(2024);
      
      // Give time for first to start processing
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Clear should abort the queued request
      testVendor.clear();
      
      // Both promises should reject with Queue cleared
      await expect(promise1).rejects.toThrow('Queue cleared');
      await expect(promise2).rejects.toThrow('Queue cleared');
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest items when cache is full', async () => {
      // Vendor has maxYears=3
      const years = [2020, 2021, 2022, 2023];
      
      for (const year of years) {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => mockYearData(year)
        });
        await vendor.requestYear(year);
      }
      
      // 2020 should have been evicted
      expect(vendor.hasYear(2020)).toBe(false);
      expect(vendor.hasYear(2021)).toBe(true);
      expect(vendor.hasYear(2022)).toBe(true);
      expect(vendor.hasYear(2023)).toBe(true);
    });
  });

  describe('Year bounds validation', () => {
    describe('getEarliestYear', () => {
      it('should return 2006 as the earliest year', () => {
        expect(YearDataVendor.getEarliestYear()).toBe(2006);
      });
    });

    describe('getLatestYear', () => {
      it('should return the current year', () => {
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
        expect(YearDataVendor.getLatestYear()).toBe(2024);
      });

      it('should update when the year changes', () => {
        // On Jan 1, 2025, latestDataDay is Dec 31, 2024, so latestDataYear is still 2024
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 1));
        expect(YearDataVendor.getLatestYear()).toBe(2024);
        
        // On Jan 2, 2025, latestDataDay is Jan 1, 2025, so latestDataYear is 2025
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 2));
        expect(YearDataVendor.getLatestYear()).toBe(2025);
      });
    });

    describe('isValidYear', () => {
      it('should accept valid years', () => {
        expect(YearDataVendor.isValidYear(2006)).toBe(true);
        expect(YearDataVendor.isValidYear(2015)).toBe(true);
        expect(YearDataVendor.isValidYear(2024)).toBe(true);
      });

      it('should reject years before 2006', () => {
        expect(YearDataVendor.isValidYear(2005)).toBe(false);
        expect(YearDataVendor.isValidYear(2000)).toBe(false);
        expect(YearDataVendor.isValidYear(1999)).toBe(false);
      });

      it('should reject years after the current year', () => {
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
        expect(YearDataVendor.isValidYear(2025)).toBe(false);
        expect(YearDataVendor.isValidYear(2030)).toBe(false);
      });
    });

    describe('requestYear with year validation', () => {
      it('should throw error for year before 2006', async () => {
        await expect(vendor.requestYear(2005)).rejects.toThrow(
          'Year 2005 is outside valid bounds. Data is available from 2006 to 2024.'
        );
      });

      it('should throw error for future year', async () => {
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
        await expect(vendor.requestYear(2025)).rejects.toThrow(
          'Year 2025 is outside valid bounds. Data is available from 2006 to 2024.'
        );
      });

      it('should accept valid year within bounds', async () => {
        const mockData = mockYearData(2020);
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => mockData
        });

        const result = await vendor.requestYear(2020);
        expect(result.year).toBe(2020);
      });
    });

    describe('getYearSync with year validation', () => {
      it('should throw error for year before 2006', () => {
        expect(() => vendor.getYearSync(2005)).toThrow(
          'Year 2005 is outside valid bounds. Data is available from 2006 to 2024.'
        );
      });

      it('should throw error for future year', () => {
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
        expect(() => vendor.getYearSync(2025)).toThrow(
          'Year 2025 is outside valid bounds. Data is available from 2006 to 2024.'
        );
      });

      it('should return null for valid but uncached year', () => {
        expect(vendor.getYearSync(2020)).toBeNull();
      });
    });

    describe('Year boundary edge cases', () => {
      it('should handle year boundary on Dec 31', () => {
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 12, 31));
        expect(YearDataVendor.getLatestYear()).toBe(2024);
        expect(YearDataVendor.isValidYear(2024)).toBe(true);
        expect(YearDataVendor.isValidYear(2025)).toBe(false);
      });

      it('should handle year boundary on Jan 1', () => {
        // On Jan 1, 2025, latestDataDay is Dec 31, 2024, so latestDataYear is 2024
        mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 1));
        expect(YearDataVendor.getLatestYear()).toBe(2024);
        expect(YearDataVendor.isValidYear(2024)).toBe(true);
        expect(YearDataVendor.isValidYear(2025)).toBe(false);
        expect(YearDataVendor.isValidYear(2026)).toBe(false);
      });
    });
  });
});