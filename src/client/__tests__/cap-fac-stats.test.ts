import { QueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import * as dateUtils from '@/shared/date-utils';
import { MockCanvas } from './helpers/mock-canvas';
import { createCapFacYear } from '../cap-fac-year';
import { yearQueryOptions } from '../year-queries';
import {
  calculateFacilityStats,
  calculateRegionStats,
  calculateAverageCapacityFactor,
  getFacilityCodesInRegion,
  getRegionNames
} from '../cap-fac-stats';

global.OffscreenCanvas = MockCanvas as unknown as typeof OffscreenCanvas;

// Mock the date utilities so "today" (and hence the valid year range) is fixed
jest.mock('@/shared/date-utils', () => ({
  ...jest.requireActual('@/shared/date-utils'),
  getTodayAEST: jest.fn()
}));

const mockGetTodayAEST = dateUtils.getTodayAEST as jest.MockedFunction<typeof dateUtils.getTodayAEST>;

// 2023: a non-leap year, so every unit history is 365 days.
const YEAR = 2023;

interface UnitSpec {
  duid: string;
  facilityCode: string;
  region: string;
  capacity: number;
  capacityFactor: number | null;
}

const makeDTO = (units: UnitSpec[]): GeneratingUnitCapFacHistoryDTO => ({
  type: 'capacity_factors',
  version: '1.0',
  created_at: '2024-01-01T00:00:00+10:00',
  data: units.map(unit => ({
    network: 'NEM',
    region: unit.region,
    data_type: 'capacity_factor',
    units: 'MW',
    capacity: unit.capacity,
    duid: unit.duid,
    facility_code: unit.facilityCode,
    facility_name: `${unit.facilityCode} Station`,
    fueltech: 'coal_black',
    history: {
      data: Array(365).fill(unit.capacityFactor),
      start: `${YEAR}-01-01`,
      last: `${YEAR}-12-31`,
      interval: '1d'
    }
  }))
});

describe('cap-fac-stats', () => {
  let queryClient: QueryClient;

  const seedYear = (year: number, dto: GeneratingUnitCapFacHistoryDTO) => {
    queryClient.setQueryData(yearQueryOptions(year).queryKey, createCapFacYear(year, dto));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
    queryClient = new QueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe('calculateFacilityStats', () => {
    it('sums capacity-weighted factors over the date range', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 50 }
      ]));

      // 10 days inclusive at CF 50 and capacity 100
      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(YEAR, 3, 1),
        end: new CalendarDate(YEAR, 3, 10)
      });

      expect(stats).toEqual({
        totalWeightedCapacityFactor: 50 * 100 * 10,
        totalCapacityDays: 100 * 10
      });
      expect(calculateAverageCapacityFactor(stats)).toBe(50);
    });

    it('skips null days (no data) without treating them as zero', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: null }
      ]));

      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(YEAR, 3, 1),
        end: new CalendarDate(YEAR, 3, 10)
      });

      // All days null → nothing accumulated → average is null, not 0
      expect(stats).toEqual({ totalWeightedCapacityFactor: 0, totalCapacityDays: 0 });
      expect(calculateAverageCapacityFactor(stats)).toBeNull();
    });

    it('returns null when the year is not in the cache', () => {
      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(YEAR, 3, 1),
        end: new CalendarDate(YEAR, 3, 10)
      });

      expect(stats).toBeNull();
    });

    it('returns null when the range spans an uncached second year', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 50 }
      ]));

      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(YEAR, 12, 25),
        end: new CalendarDate(YEAR + 1, 1, 5)
      });

      expect(stats).toBeNull();
    });

    it('spans two cached years', () => {
      const spec: UnitSpec[] = [
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 40 }
      ];
      seedYear(YEAR, makeDTO(spec));
      seedYear(YEAR + 1, makeDTO(spec));

      // 7 days of 2023 + 5 days of 2024, all at CF 40, capacity 100
      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(YEAR, 12, 25),
        end: new CalendarDate(YEAR + 1, 1, 5)
      });

      expect(stats).toEqual({
        totalWeightedCapacityFactor: 40 * 100 * 12,
        totalCapacityDays: 100 * 12
      });
    });

    it('returns null for out-of-bounds years', () => {
      const stats = calculateFacilityStats(queryClient, 'FACA', {
        start: new CalendarDate(2005, 1, 1),
        end: new CalendarDate(2005, 1, 10)
      });

      expect(stats).toBeNull();
    });
  });

  describe('calculateRegionStats', () => {
    it('aggregates across all facilities in the region, weighted by capacity', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 },
        { duid: 'B1', facilityCode: 'FACB', region: 'NSW1', capacity: 300, capacityFactor: 20 },
        { duid: 'C1', facilityCode: 'FACC', region: 'QLD1', capacity: 500, capacityFactor: 90 }
      ]));

      const dateRange = {
        start: new CalendarDate(YEAR, 6, 1),
        end: new CalendarDate(YEAR, 6, 10)
      };

      const stats = calculateRegionStats(queryClient, 'NSW1', dateRange);

      // FACC (QLD1) must not contribute
      expect(stats).toEqual({
        totalWeightedCapacityFactor: (60 * 100 + 20 * 300) * 10,
        totalCapacityDays: (100 + 300) * 10
      });
      // Capacity-weighted average: (60·100 + 20·300) / 400 = 30
      expect(calculateAverageCapacityFactor(stats)).toBe(30);
    });

    it('returns null when the year is not cached', () => {
      const stats = calculateRegionStats(queryClient, 'NSW1', {
        start: new CalendarDate(YEAR, 6, 1),
        end: new CalendarDate(YEAR, 6, 10)
      });

      expect(stats).toBeNull();
    });
  });

  describe('getFacilityCodesInRegion', () => {
    it('lists each facility once', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 },
        { duid: 'A2', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 },
        { duid: 'C1', facilityCode: 'FACC', region: 'QLD1', capacity: 500, capacityFactor: 90 }
      ]));

      expect(getFacilityCodesInRegion(queryClient, 'NSW1', YEAR)).toEqual(['FACA']);
      expect(getFacilityCodesInRegion(queryClient, 'QLD1', YEAR)).toEqual(['FACC']);
    });

    it('returns null when the year is not cached', () => {
      expect(getFacilityCodesInRegion(queryClient, 'NSW1', YEAR)).toBeNull();
    });
  });

  describe('getRegionNames', () => {
    it('maps known region codes', () => {
      expect(getRegionNames('NSW1')).toEqual({ long: 'New South Wales', short: 'NSW' });
      expect(getRegionNames('WEM')).toEqual({ long: 'Western Australia', short: 'WA' });
    });

    it('falls back to the code for unknown regions', () => {
      expect(getRegionNames('XYZ')).toEqual({ long: 'XYZ', short: 'XYZ' });
    });
  });
});
