import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import type { TooltipSource } from '@/components/CapFacTooltip';
import * as dateUtils from '@/shared/date-utils';
import { MockCanvas } from './helpers/mock-canvas';
import { makeDTO as buildDTO } from './helpers/make-dto';
import type { UnitSpec } from './helpers/make-dto';
import { createCapFacYear } from '../cap-fac-year';
import { yearQueryOptions } from '../year-queries';
import { resolveTooltip } from '../tooltip-resolve';

global.OffscreenCanvas = MockCanvas as unknown as typeof OffscreenCanvas;

vi.mock('@/shared/date-utils', async () => ({
  ...(await vi.importActual<typeof import('@/shared/date-utils')>('@/shared/date-utils')),
  getTodayAEST: vi.fn()
}));

const mockGetTodayAEST = dateUtils.getTodayAEST as MockedFunction<typeof dateUtils.getTodayAEST>;

const YEAR = 2023;
const MODE = 'full' as const;

const makeDTO = (units: UnitSpec[]): GeneratingUnitCapFacHistoryDTO => buildDTO(units, YEAR);

// NSW1: (60·100 + 20·300) / 400 = 30. QLD1: 90.
const FLEET: UnitSpec[] = [
  { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 },
  { duid: 'B1', facilityCode: 'FACB', region: 'NSW1', capacity: 300, capacityFactor: 20 },
  { duid: 'C1', facilityCode: 'FACC', region: 'QLD1', capacity: 500, capacityFactor: 90 }
];

describe('resolveTooltip', () => {
  let queryClient: QueryClient;

  const seedYear = (year: number, dto: GeneratingUnitCapFacHistoryDTO) => {
    queryClient.setQueryData(
      yearQueryOptions(queryClient, MODE, year).queryKey,
      createCapFacYear(year, dto),
    );
  };

  /** Resolve as New South Wales' header would. */
  const resolveForNSW = (
    source: TooltipSource | null,
    dateRange: { start: CalendarDate; end: CalendarDate } | null
  ) => resolveTooltip({
    source,
    regionCode: 'NSW1',
    regionLabel: 'New South Wales',
    dateRange,
    queryClient,
    mode: MODE,
  });

  const JUNE = {
    start: new CalendarDate(YEAR, 6, 1),
    end: new CalendarDate(YEAR, 6, 10)
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
    queryClient = new QueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('shows nothing when nothing is pointed at', () => {
    expect(resolveForNSW(null, JUNE)).toBeNull();
  });

  describe('period sources', () => {
    const REGION_SOURCE: TooltipSource = { tooltipType: 'period', regionCode: 'NSW1' };

    it("takes its dates and its value from the window on screen, not the event", () => {
      seedYear(YEAR, makeDTO(FLEET));

      const data = resolveForNSW(REGION_SOURCE, JUNE);

      expect(data).toMatchObject({
        startDate: JUNE.start,
        endDate: JUNE.end,
        label: 'New South Wales',
        capacityFactor: 30,
        tooltipType: 'period',
        regionCode: 'NSW1'
      });
    });

    // The bug this whole change exists to fix: the source is a description of
    // what is pointed at and carries no dates, so moving the window moves the
    // readout — no re-broadcast required.
    it('follows the window when the range moves under a stationary pointer', () => {
      // A fleet whose first quarter runs at 10 and the rest of the year at 60,
      // so the two windows genuinely differ.
      const dto = makeDTO([
        { duid: 'A1', facilityCode: 'FACA', region: 'NSW1', capacity: 100, capacityFactor: 60 }
      ]);
      for (let day = 0; day < 90; day++) dto.data[0].history.data![day] = 10;
      seedYear(YEAR, dto);

      const march = resolveForNSW(REGION_SOURCE, {
        start: new CalendarDate(YEAR, 2, 1),
        end: new CalendarDate(YEAR, 2, 10)
      });
      const june = resolveForNSW(REGION_SOURCE, JUNE);

      expect(march!.startDate.toString()).not.toBe(june!.startDate.toString());
      expect(march!.capacityFactor).toBe(10);
      expect(june!.capacityFactor).toBe(60);
    });

    it('gives the pointed-at facility its own average, under its own name', () => {
      seedYear(YEAR, makeDTO(FLEET));

      const data = resolveForNSW(
        { tooltipType: 'period', regionCode: 'NSW1', facilityCode: 'FACB', label: 'Facility B' },
        JUNE
      );

      expect(data).toMatchObject({
        label: 'Facility B',
        facilityCode: 'FACB',
        capacityFactor: 20
      });
    });

    it("gives every other region its own average over the same period", () => {
      seedYear(YEAR, makeDTO(FLEET));

      // A Queensland facility is pointed at; NSW's header answers for NSW.
      const data = resolveForNSW(
        { tooltipType: 'period', regionCode: 'QLD1', facilityCode: 'FACC', label: 'Facility C' },
        JUNE
      );

      expect(data).toMatchObject({
        label: 'New South Wales',
        capacityFactor: 30,
        startDate: JUNE.start,
        endDate: JUNE.end
      });
      expect(data!.facilityCode).toBeUndefined();
    });

    it('shows the new dates with no value when the year has not loaded', () => {
      const data = resolveForNSW(REGION_SOURCE, JUNE);

      // Null is "no data", never zero — CapFacTooltip renders it as an em dash.
      expect(data).toMatchObject({ startDate: JUNE.start, endDate: JUNE.end });
      expect(data!.capacityFactor).toBeNull();
    });

    it('resolves to nothing before the timeline has a window', () => {
      // getTooltipFormattedDate throws on a period with no endDate, so a period
      // must never escape this function without one.
      seedYear(YEAR, makeDTO(FLEET));
      expect(resolveForNSW(REGION_SOURCE, null)).toBeNull();
    });

    it('carries the pinned flag through', () => {
      seedYear(YEAR, makeDTO(FLEET));
      expect(resolveForNSW({ ...REGION_SOURCE, pinned: true }, JUNE)!.pinned).toBe(true);
    });
  });

  describe('day sources', () => {
    const DAY = new CalendarDate(YEAR, 6, 5);

    it('passes the pointed-at region straight through, unit and all', () => {
      seedYear(YEAR, makeDTO(FLEET));

      const source: TooltipSource = {
        startDate: DAY,
        endDate: null,
        label: 'FACA A1',
        capacityFactor: 60,
        tooltipType: 'day',
        regionCode: 'NSW1',
        facilityCode: 'FACA',
        unitName: 'A1'
      };

      expect(resolveForNSW(source, JUNE)).toBe(source);
    });

    it("gives another region that one day's average", () => {
      seedYear(YEAR, makeDTO(FLEET));

      const data = resolveForNSW({
        startDate: DAY,
        endDate: null,
        label: 'FACC C1',
        capacityFactor: 90,
        tooltipType: 'day',
        regionCode: 'QLD1',
        unitName: 'C1'
      }, JUNE);

      expect(data).toMatchObject({
        startDate: DAY,
        endDate: null,
        label: 'New South Wales',
        capacityFactor: 30,
        tooltipType: 'day'
      });
    });
  });

  describe('month sources', () => {
    const MONTH = new CalendarDate(YEAR, 6, 1);

    // Regression: the other regions used to derive their range from the event's
    // {start, end ?? start}, and a month event carries endDate: null — so they
    // showed the 1st of the month's value labelled as the whole month.
    it("gives another region the month's roll-up, not the first day's", () => {
      const dto = makeDTO(FLEET);
      // Make 1 June unrepresentative for every NSW unit.
      const firstOfJune = 31 + 28 + 31 + 30 + 31; // day index of 1 June, non-leap
      dto.data[0].history.data![firstOfJune] = 0;
      dto.data[1].history.data![firstOfJune] = 0;
      seedYear(YEAR, dto);

      const data = resolveForNSW({
        startDate: MONTH,
        endDate: null,
        label: 'Queensland',
        capacityFactor: 90,
        tooltipType: 'month',
        regionCode: 'QLD1'
      }, JUNE);

      expect(data!.tooltipType).toBe('month');
      expect(data!.label).toBe('New South Wales');
      // The month average, barely moved by one zero day — not 0.
      expect(data!.capacityFactor).toBeGreaterThan(28);
      expect(data!.capacityFactor).toBeLessThan(30);
    });

    it('passes the pointed-at region straight through', () => {
      seedYear(YEAR, makeDTO(FLEET));

      const source: TooltipSource = {
        startDate: MONTH,
        endDate: null,
        label: 'New South Wales',
        capacityFactor: 30,
        tooltipType: 'month',
        regionCode: 'NSW1'
      };

      expect(resolveForNSW(source, JUNE)).toBe(source);
    });
  });
});
