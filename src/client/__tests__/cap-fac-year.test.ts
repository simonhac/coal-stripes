import {
  createCapFacYear,
  inferredRegionStart,
  leadingBackgroundDays,
  regionHasDataInWindow,
} from '../cap-fac-year';
import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { MockCanvas } from './helpers/mock-canvas';
import { CalendarDate, endOfMonth } from '@internationalized/date';

// Mock OffscreenCanvas
global.OffscreenCanvas = MockCanvas as any;

// The real DTO carries one capacity factor per day. These tests express intent
// as 12 monthly values, so expand them into a daily array aligned to the year's
// actual month lengths (so month boundaries match getDayIndex()).
function monthlyToDaily(year: number, monthly: (number | null)[]): (number | null)[] {
  const daily: (number | null)[] = [];
  for (let m = 0; m < 12; m++) {
    const daysInMonth = endOfMonth(new CalendarDate(year, m + 1, 1)).day;
    for (let d = 0; d < daysInMonth; d++) daily.push(monthly[m]);
  }
  return daily;
}

describe('cap-fac-year', () => {
  describe('createCapFacYear', () => {
    it('should create region capacity factors for NEM units', () => {
      // Create daily data for 365 days
      // For unit 1: Monthly averages should be 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0, 0.1, 0.2, 0.3
      const unit1DailyData = new Array(365).fill(null).map((_, dayIndex) => {
        const monthValues = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0, 0.1, 0.2, 0.3];
        const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let currentMonth = 0;
        let daysSoFar = 0;
        
        for (let m = 0; m < 12; m++) {
          if (dayIndex < daysSoFar + daysPerMonth[m]) {
            currentMonth = m;
            break;
          }
          daysSoFar += daysPerMonth[m];
        }
        
        return monthValues[currentMonth];
      });
      
      // For unit 2: Monthly averages should be 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.2, 0.3, 0.4  
      const unit2DailyData = new Array(365).fill(null).map((_, dayIndex) => {
        const monthValues = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.2, 0.3, 0.4];
        const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let currentMonth = 0;
        let daysSoFar = 0;
        
        for (let m = 0; m < 12; m++) {
          if (dayIndex < daysSoFar + daysPerMonth[m]) {
            currentMonth = m;
            break;
          }
          daysSoFar += daysPerMonth[m];
        }
        
        return monthValues[currentMonth];
      });

      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'NEM',
            region: 'NSW1',
            capacity: 100,
            duid: 'UNIT1',
            facility_code: 'FAC1',
            facility_name: 'Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'day',
              data: unit1DailyData
            }
          },
          {
            network: 'NEM',
            region: 'NSW1',
            capacity: 200,
            duid: 'UNIT2',
            facility_code: 'FAC1',
            facility_name: 'Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'day',
              data: unit2DailyData
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      expect(result.regionCapacityFactors.has('NSW1')).toBe(true);
      const nsw1Factors = result.regionCapacityFactors.get('NSW1');
      expect(nsw1Factors).toHaveLength(12);
      
      // Check capacity-weighted average for first month: (0.8*100 + 0.9*200)/(100+200) = 0.867
      expect(nsw1Factors![0]).toBeCloseTo(0.867, 3);
      
      // Check capacity-weighted average for last month: (0.3*100 + 0.4*200)/(100+200) = 0.367
      expect(nsw1Factors![11]).toBeCloseTo(0.367, 3);
    });

    it('should handle WEM network units with WEM region', () => {
      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'WEM',
            // Note: WEM units don't have a region property
            capacity: 150,
            duid: 'WEM_UNIT1',
            facility_code: 'WEM_FAC1',
            facility_name: 'WEM Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      expect(result.regionCapacityFactors.has('WEM')).toBe(true);
      const wemFactors = result.regionCapacityFactors.get('WEM');
      expect(wemFactors).toHaveLength(12);
      
      // All months should be 0.5
      for (let i = 0; i < 12; i++) {
        expect(wemFactors![i]).toBe(0.5);
      }
    });

    it('should handle null capacity factors correctly', () => {
      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'NEM',
            region: 'QLD1',
            capacity: 100,
            duid: 'UNIT1',
            facility_code: 'FAC1',
            facility_name: 'Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.8, null, 0.6, null, null, null, 0.2, 0.1, null, 0.1, 0.2, 0.3])
            }
          },
          {
            network: 'NEM',
            region: 'QLD1',
            capacity: 200,
            duid: 'UNIT2',
            facility_code: 'FAC2',
            facility_name: 'Facility 2',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [null, 0.8, 0.7, null, 0.5, null, null, 0.2, null, null, 0.3, null])
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      const qld1Factors = result.regionCapacityFactors.get('QLD1');
      expect(qld1Factors).toHaveLength(12);
      
      // Month 0: only unit 1 has data (0.8)
      expect(qld1Factors![0]).toBeCloseTo(0.8, 10);

      // Month 1: only unit 2 has data (0.8)
      expect(qld1Factors![1]).toBeCloseTo(0.8, 10);
      
      // Month 2: both units have data, weighted average: (0.6*100 + 0.7*200)/(100+200) = 0.667
      expect(qld1Factors![2]).toBeCloseTo(0.667, 3);
      
      // Month 3: both units have null
      expect(qld1Factors![3]).toBe(null);
      
      // Month 5: both units have null
      expect(qld1Factors![5]).toBe(null);
    });

    it('should handle units with missing region as UNKNOWN', () => {
      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'NEM',
            // Missing region property
            capacity: 100,
            duid: 'UNIT1',
            facility_code: 'FAC1',
            facility_name: 'Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      expect(result.regionCapacityFactors.has('UNKNOWN')).toBe(true);
      const unknownFactors = result.regionCapacityFactors.get('UNKNOWN');
      expect(unknownFactors).toHaveLength(12);
    });

    it('should handle multiple regions correctly', () => {
      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'NEM',
            region: 'NSW1',
            capacity: 100,
            duid: 'NSW_UNIT1',
            facility_code: 'NSW_FAC1',
            facility_name: 'NSW Facility',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8])
            }
          },
          {
            network: 'NEM',
            region: 'VIC1',
            capacity: 200,
            duid: 'VIC_UNIT1',
            facility_code: 'VIC_FAC1',
            facility_name: 'VIC Facility',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6])
            }
          },
          {
            network: 'WEM',
            capacity: 150,
            duid: 'WEM_UNIT1',
            facility_code: 'WEM_FAC1',
            facility_name: 'WEM Facility',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4])
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      // Should have 3 regions
      expect(result.regionCapacityFactors.size).toBe(3);
      expect(result.regionCapacityFactors.has('NSW1')).toBe(true);
      expect(result.regionCapacityFactors.has('VIC1')).toBe(true);
      expect(result.regionCapacityFactors.has('WEM')).toBe(true);

      // Check values
      expect(result.regionCapacityFactors.get('NSW1')![0]).toBeCloseTo(0.8, 10);
      expect(result.regionCapacityFactors.get('VIC1')![0]).toBeCloseTo(0.6, 10);
      expect(result.regionCapacityFactors.get('WEM')![0]).toBeCloseTo(0.4, 10);
    });

    it('should handle zero capacity correctly', () => {
      const mockData: GeneratingUnitCapFacHistoryDTO = {
        type: 'capacity_factors',
        version: '1.0',
        created_at: '2024-01-01',
        data: [
          {
            network: 'NEM',
            region: 'NSW1',
            capacity: 100,
            duid: 'UNIT1',
            facility_code: 'FAC1',
            facility_name: 'Facility 1',
            fueltech: 'coal_black',
            status: 'operating',
            history: {
              start: '2024-01-01',
              last: '2024-12-31',
              interval: 'month',
              data: monthlyToDaily(2024, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
            }
          }
        ]
      };

      const result = createCapFacYear(2024, mockData);

      const nsw1Factors = result.regionCapacityFactors.get('NSW1');
      
      // All months should be 0.0 (not null)
      for (let i = 0; i < 12; i++) {
        expect(nsw1Factors![i]).toBe(0.0);
      }
    });
  });
});

/**
 * The leading page-background overlay, and the WEM regression it exists for.
 *
 * The record as a whole starts 1998-12-07, but WEM's coal series does not begin
 * until 2006-09-20. Using only the global boundary left every WEM day between
 * those two dates painted as pale blue "no data" — a hole in the record where
 * there was no record yet — the instant one day of real WEM data entered the
 * window and the whole-row `regionHasDataInWindow` fill stopped applying.
 */
describe('leadingBackgroundDays', () => {
  const GLOBAL = new CalendarDate(1998, 12, 7);
  const WEM_START = new CalendarDate(2006, 9, 20);
  const TILE = 365;

  it('covers everything before a region whose record starts late', () => {
    // The exact window the bug was measured on: 348 of 365 days were pale blue.
    const windowStart = new CalendarDate(2005, 10, 7);
    expect(leadingBackgroundDays(windowStart, GLOBAL, WEM_START, TILE)).toBe(348);
  });

  it('covers a whole tile still entirely before the region starts', () => {
    expect(leadingBackgroundDays(new CalendarDate(2003, 1, 1), GLOBAL, WEM_START, TILE)).toBe(TILE);
  });

  it('covers nothing once the window is wholly inside the region record', () => {
    expect(leadingBackgroundDays(new CalendarDate(2010, 1, 1), GLOBAL, WEM_START, TILE)).toBe(0);
  });

  it('leaves a region that starts with the record alone', () => {
    // A NEM region in 2005: its first data day is long past, so no leading fill.
    const nswStart = new CalendarDate(2005, 1, 1);
    expect(leadingBackgroundDays(new CalendarDate(2005, 10, 7), GLOBAL, nswStart, TILE)).toBe(0);
  });

  it('still honours the global boundary when the region start is unknown', () => {
    // Overstepping to the left of the record with no region bound available.
    expect(leadingBackgroundDays(new CalendarDate(1998, 11, 7), GLOBAL, null, TILE)).toBe(30);
  });

  it('takes the later of the two boundaries, never the earlier', () => {
    const windowStart = new CalendarDate(1998, 11, 7);
    // Region starts later than the global record: the region bound must win.
    expect(leadingBackgroundDays(windowStart, GLOBAL, WEM_START, TILE)).toBe(TILE);
  });
});

/**
 * Whether a region has any data in the VISIBLE WINDOW — which is a different
 * question from where its record begins, and must not be answered with the same
 * number.
 *
 * The bug this pins: stepping the window one day, from ending 31 Dec 2005 to
 * ending 1 Jan 2006, flipped every WEM row from page background to a solid year
 * of pale blue. The window now touched 2006, 2006 has WEM data *somewhere*
 * (from 20 September), and a test that asked only "does the end year have any
 * data at all" said yes — for a window whose last visible day is 1 January.
 *
 * Both halves have to be positional: data lands in the visible TAIL of the start
 * year if that year's last data day reaches it, and in the visible HEAD of the
 * end year if that year's first data day falls inside it.
 */
describe('regionHasDataInWindow', () => {
  const WEM = 'WEM';
  /** 0-based day-of-year of 20 Sep 2006, WEM's first day of coal data. */
  const WEM_FIRST_2006 = 262;

  const bounds = (first: number, last: number) => ({
    regionFirstDataDayIndex: new Map([[WEM, first]]),
    regionLastDataDayIndex: new Map([[WEM, last]]),
  });

  // 2005 holds no WEM data at all; 2006 holds it from 20 Sep to year end.
  const y2005 = bounds(-1, -1);
  const y2006 = bounds(WEM_FIRST_2006, 364);

  it('reports nothing for a window wholly inside the empty year', () => {
    // 1 Jan – 31 Dec 2005.
    expect(regionHasDataInWindow(y2005, undefined, WEM, 0, 364, true)).toBe(false);
  });

  it('reports nothing when the window only just reaches into the year data starts', () => {
    // 2 Jan 2005 – 1 Jan 2006: one visible day of 2006, 262 days before WEM
    // begins. This is the step that used to turn the whole region pale blue.
    expect(regionHasDataInWindow(y2005, y2006, WEM, 1, 0, false)).toBe(false);
  });

  it('reports data once the window head reaches the region first data day', () => {
    // 7 Oct 2005 – 6 Oct 2006: day 278 of 2006 is visible, and WEM starts on 262.
    expect(regionHasDataInWindow(y2005, y2006, WEM, 279, 278, false)).toBe(true);
  });

  it('reports data when the start year tail carries it', () => {
    // A later window: 2006 data reaches the year end, so the tail is populated.
    expect(regionHasDataInWindow(y2006, bounds(0, 364), WEM, 300, 100, false)).toBe(true);
  });

  it('reports nothing when the start year data stops before the window opens', () => {
    // A region retired mid-year: last data day 100, window opens on day 200.
    expect(regionHasDataInWindow(bounds(0, 100), undefined, WEM, 200, 364, true)).toBe(false);
  });

  it('reports nothing while the years are still loading', () => {
    expect(regionHasDataInWindow(undefined, undefined, WEM, 0, 364, true)).toBe(false);
  });
});

/**
 * The stand-in for the metadata blob's region first-data day, used only while
 * there isn't one — a cold store, or the window after a deploy before the cron
 * has scanned.
 *
 * It is the loaded year's own first data day, which is what this used to be
 * before the fact existed. Deliberately NOT the minimum of the units'
 * `first_seen`: that field reports the start of a unit's later contiguous run,
 * so it can only ever be too LATE, and too late here means painting page
 * background over real generation. An inference drawn from actual values can
 * never do that — its failure mode is the harmless one, reading a year-long
 * collection gap as a start, which is exactly what it did before.
 */
describe('inferredRegionStart', () => {
  const WEM = 'WEM';
  const bounds = (first: number) => ({
    regionFirstDataDayIndex: new Map([[WEM, first]]),
    regionLastDataDayIndex: new Map([[WEM, 364]]),
  });

  it('reads the first data day of the loaded year', () => {
    // 20 Sep 2006 is day 262 of 2006.
    expect(inferredRegionStart(2006, bounds(262), WEM)?.toString()).toBe('2006-09-20');
  });

  it('has no answer for a year with no data for the region', () => {
    expect(inferredRegionStart(2005, bounds(-1), WEM)).toBeNull();
  });

  it('has no answer while the year is still loading', () => {
    expect(inferredRegionStart(2005, undefined, WEM)).toBeNull();
  });

  it('has no answer for a region the year does not mention', () => {
    expect(inferredRegionStart(2006, bounds(262), 'NSW1')).toBeNull();
  });
});
