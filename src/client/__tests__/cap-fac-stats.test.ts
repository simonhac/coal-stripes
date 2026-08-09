import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import * as dateUtils from '@/shared/date-utils';
import { MockCanvas } from './helpers/mock-canvas';
import { makeDTO as buildDTO } from './helpers/make-dto';
import type { UnitSpec } from './helpers/make-dto';
import { createCapFacYear } from '../cap-fac-year';
import { yearQueryOptions } from '../year-queries';
import {
  calculateFacilityStats,
  calculateRegionStats,
  calculateAverageCapacityFactor,
  getFacilityCodesInRegion,
  getFacilityLifecycle,
  getRegionMonthCapacityFactor,
  getRegionNames
} from '../cap-fac-stats';

global.OffscreenCanvas = MockCanvas as unknown as typeof OffscreenCanvas;

// Mock the date utilities so "today" (and hence the valid year range) is fixed
vi.mock('@/shared/date-utils', async () => ({
  ...(await vi.importActual<typeof import('@/shared/date-utils')>('@/shared/date-utils')),
  getTodayAEST: vi.fn()
}));

const mockGetTodayAEST = dateUtils.getTodayAEST as MockedFunction<typeof dateUtils.getTodayAEST>;

// 2023: a non-leap year, so every unit history is 365 days.
const YEAR = 2023;
// The stats helpers are mode-scoped (they read the per-mode query cache); these
// tests exercise a single mode.
const MODE = 'full' as const;

const makeDTO = (units: UnitSpec[]): GeneratingUnitCapFacHistoryDTO => buildDTO(units, YEAR);

describe('cap-fac-stats', () => {
  let queryClient: QueryClient;

  const seedYear = (year: number, dto: GeneratingUnitCapFacHistoryDTO) => {
    queryClient.setQueryData(
      yearQueryOptions(queryClient, MODE, year).queryKey,
      createCapFacYear(year, dto),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
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

      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
        start: new CalendarDate(YEAR, 3, 1),
        end: new CalendarDate(YEAR, 3, 10)
      });

      // All days null → nothing accumulated → average is null, not 0
      expect(stats).toEqual({ totalWeightedCapacityFactor: 0, totalCapacityDays: 0 });
      expect(calculateAverageCapacityFactor(stats)).toBeNull();
    });

    it('returns null when the year is not in the cache', () => {
      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
        start: new CalendarDate(YEAR, 3, 1),
        end: new CalendarDate(YEAR, 3, 10)
      });

      expect(stats).toBeNull();
    });

    it('returns null when the range spans an uncached second year', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 50 }
      ]));

      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
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
      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
        start: new CalendarDate(YEAR, 12, 25),
        end: new CalendarDate(YEAR + 1, 1, 5)
      });

      expect(stats).toEqual({
        totalWeightedCapacityFactor: 40 * 100 * 12,
        totalCapacityDays: 100 * 12
      });
    });

    it('returns null for out-of-bounds years', () => {
      const stats = calculateFacilityStats(queryClient, MODE,'FACA', {
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

      const stats = calculateRegionStats(queryClient, MODE,'NSW1', dateRange);

      // FACC (QLD1) must not contribute
      expect(stats).toEqual({
        totalWeightedCapacityFactor: (60 * 100 + 20 * 300) * 10,
        totalCapacityDays: (100 + 300) * 10
      });
      // Capacity-weighted average: (60·100 + 20·300) / 400 = 30
      expect(calculateAverageCapacityFactor(stats)).toBe(30);
    });

    it('returns null when the year is not cached', () => {
      const stats = calculateRegionStats(queryClient, MODE,'NSW1', {
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

      expect(getFacilityCodesInRegion(queryClient, MODE,'NSW1', YEAR)).toEqual(['FACA']);
      expect(getFacilityCodesInRegion(queryClient, MODE,'QLD1', YEAR)).toEqual(['FACC']);
    });

    it('returns null when the year is not cached', () => {
      expect(getFacilityCodesInRegion(queryClient, MODE,'NSW1', YEAR)).toBeNull();
    });
  });

  describe('getRegionMonthCapacityFactor', () => {
    it('reads the month roll-up, capacity-weighted across the region', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 },
        { duid: 'B1', facilityCode: 'FACB', region: 'NSW1', capacity: 300, capacityFactor: 20 },
        { duid: 'C1', facilityCode: 'FACC', region: 'QLD1', capacity: 500, capacityFactor: 90 }
      ]));

      // (60·100 + 20·300) / 400 = 30
      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'NSW1', new CalendarDate(YEAR, 6, 1)))
        .toBe(30);
      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'QLD1', new CalendarDate(YEAR, 6, 1)))
        .toBe(90);
    });

    it('answers the same for any day of the month — the month is the unit', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 45 }
      ]));

      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'NSW1', new CalendarDate(YEAR, 6, 1)))
        .toBe(45);
      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'NSW1', new CalendarDate(YEAR, 6, 30)))
        .toBe(45);
    });

    it('returns null when the year is not cached, and for an unknown region', () => {
      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'NSW1', new CalendarDate(YEAR, 6, 1)))
        .toBeNull();

      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 45 }
      ]));
      expect(getRegionMonthCapacityFactor(queryClient, MODE, 'TAS1', new CalendarDate(YEAR, 6, 1)))
        .toBeNull();
    });
  });

  describe('getFacilityLifecycle', () => {
    const RANGE = { start: new CalendarDate(YEAR, 3, 1), end: new CalendarDate(YEAR, 3, 10) };

    it('reports the commissioning year, and a span once a unit has retired', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 720, capacityFactor: 60,
          commenced: '1981-12-31' },
        { duid: 'A2', facilityCode: 'FACA', region: 'NSW1', capacity: 500, capacityFactor: 60,
          commenced: '1972-12-31', status: 'retired', lastSeen: '2023-04-24' }
      ]));

      expect(getFacilityLifecycle(queryClient, MODE, 'FACA', RANGE)).toEqual({
        totalCapacity: 1220,
        units: [
          { name: 'A1', capacity: 720, commencedYear: 1981, retiredYear: null },
          { name: 'A2', capacity: 500, commencedYear: 1972, retiredYear: 2023 }
        ]
      });
    });

    it('reports an unknown commissioning date as null, never a year of 0', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60,
          commenced: null }
      ]));

      expect(getFacilityLifecycle(queryClient, MODE, 'FACA', RANGE)?.units).toEqual([
        { name: 'A1', capacity: 100, commencedYear: null, retiredYear: null }
      ]);
    });

    it('drops the station prefix from WEM unit names', () => {
      seedYear(YEAR, makeDTO([
        { duid: 'MUJA_G5', facilityCode: 'MUJA', region: 'WEM', capacity: 195.8,
          capacityFactor: 60, network: 'WEM', commenced: '1981-12-31' }
      ]));

      expect(getFacilityLifecycle(queryClient, MODE, 'MUJA', RANGE)?.units[0].name).toBe('G5');
    });

    it('falls back to the end year when only that one is cached', () => {
      seedYear(YEAR + 1, makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60,
          commenced: '1981-12-31' }
      ]));

      const lifecycle = getFacilityLifecycle(queryClient, MODE, 'FACA', {
        start: new CalendarDate(YEAR, 12, 20),
        end: new CalendarDate(YEAR + 1, 1, 10)
      });

      expect(lifecycle).toEqual({
        totalCapacity: 100,
        units: [{ name: 'A1', capacity: 100, commencedYear: 1981, retiredYear: null }]
      });
    });

    it('returns null when no displayed year is cached', () => {
      expect(getFacilityLifecycle(queryClient, MODE, 'FACA', RANGE)).toBeNull();
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
