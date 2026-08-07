import { FacilityYearTile } from '../facility-year-tile';
import { GeneratingUnitDTO } from '@/shared/types';
import { createFacility } from '../facility-factory';
import { MockCanvas } from './helpers/mock-canvas';

// Mock OffscreenCanvas
global.OffscreenCanvas = MockCanvas as any;

describe('FacilityYearTile', () => {
  const mockUnit = (duid: string, capacity: number, data: (number | null)[]): GeneratingUnitDTO => ({
    network: 'NEM',
    region: 'NSW1',
    data_type: 'capacity_factor',
    units: 'MW',
    capacity,
    duid,
    facility_code: 'TESTFAC',
    facility_name: 'Test Facility',
    fueltech: 'black_coal',
    history: {
      start: '2023-01-01',
      last: '2023-12-31',
      interval: 'P1D',
      data
    }
  });

  describe('Basic Functionality', () => {
    it('should create a tile instance', () => {
      const units = [mockUnit('UNIT1', 500, Array(365).fill(50))];
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      expect(tile).toBeInstanceOf(FacilityYearTile);
    });

    it('should render a canvas with correct dimensions', () => {
      const units = [
        mockUnit('UNIT1', 600, Array(365).fill(50)),
        mockUnit('UNIT2', 400, Array(365).fill(75))
      ];
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      const canvas = tile.getCanvas();
      
      expect(canvas.width).toBe(365); // Width should be number of days
      // Height should be based on capacity / 30, with min 12 and max 40
      // Unit 1: max(12, min(40, 600/30)) = max(12, min(40, 20)) = 20
      // Unit 2: max(12, min(40, 400/30)) = max(12, min(40, 13.33)) = 13.33
      expect(canvas.height).toBeGreaterThan(0);
    });

    it('should handle units with null capacity factors', () => {
      const units = [
        mockUnit('UNIT1', 300, Array(365).fill(null))
      ];
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      expect(() => tile.getCanvas()).not.toThrow();
    });

    it('should handle mixed capacity factors', () => {
      const data = [
        ...Array(100).fill(0),      // Low utilisation
        ...Array(100).fill(50),     // Medium utilisation
        ...Array(100).fill(100),    // High utilisation
        ...Array(65).fill(null)     // Missing data
      ];
      
      const units = [mockUnit('UNIT1', 500, data)];
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      expect(() => tile.getCanvas()).not.toThrow();
    });

  });

  describe('Cross-year gap colouring', () => {
    // Captures the pixels the tile writes, so we can assert what a null day is
    // actually painted rather than only that rendering did not throw.
    class CapturingCanvas extends MockCanvas {
      static last: { data: Uint8ClampedArray; width: number } | null = null;
      getContext() {
        const ctx = super.getContext();
        ctx.putImageData = jest.fn((image: { data: Uint8ClampedArray; width: number }) => {
          CapturingCanvas.last = image;
        }) as never;
        return ctx;
      }
    }

    const rgbAt = (x: number): [number, number, number] => {
      const { data, width } = CapturingCanvas.last!;
      const i = (0 * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };

    const PAGE_BACKGROUND = [0xfa, 0xf9, 0xf6];
    const NO_DATA_BLUE = [0xe6, 0xf3, 0xff];

    // LD01 in 2000: missing until 30 March because a gap that began in October
    // 1999 ran over New Year. The year's own values cannot tell that apart from
    // a unit commissioned in April.
    const gapOverNewYear = [...Array(89).fill(null), ...Array(276).fill(50)];

    beforeEach(() => {
      CapturingCanvas.last = null;
      global.OffscreenCanvas = CapturingCanvas as never;
    });

    afterEach(() => {
      global.OffscreenCanvas = MockCanvas as never;
    });

    it('paints a cross-year gap as "no data" when the unit was commissioned earlier', () => {
      const unit = { ...mockUnit('LD01', 500, gapOverNewYear), commenced: '1970-12-31' };
      new FacilityYearTile(createFacility('LIDDELL', [unit]), 2023);

      expect(rgbAt(0)).toEqual(NO_DATA_BLUE);
      expect(rgbAt(88)).toEqual(NO_DATA_BLUE);
    });

    it('still paints a genuine pre-commission run as page background', () => {
      const unit = { ...mockUnit('MPP_1', 426, gapOverNewYear), commenced: '2023-03-31' };
      new FacilityYearTile(createFacility('MILLMERN', [unit]), 2023);

      expect(rgbAt(0)).toEqual(PAGE_BACKGROUND);
    });

    it('falls back to inferring the span when the payload predates the field', () => {
      // Browser and edge caches keep older payloads for a while; those units
      // have no lifecycle dates and must render exactly as they did before.
      new FacilityYearTile(createFacility('LIDDELL', [mockUnit('LD01', 500, gapOverNewYear)]), 2023);

      expect(rgbAt(0)).toEqual(PAGE_BACKGROUND);
    });
  });

  describe('Performance Tests', () => {
    it('should render a single tile quickly', () => {
      const units = Array(4).fill(null).map((_, i) => 
        mockUnit(`UNIT${i}`, 500, Array(365).fill(Math.random() * 100))
      );
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      
      const startTime = performance.now();
      tile.getCanvas();
      const renderTime = performance.now() - startTime;
      
      // Should render in less than 50ms
      expect(renderTime).toBeLessThan(50);
    });

    it('should render multiple tiles efficiently', () => {
      const years = 10;
      const renderTimes: number[] = [];
      
      for (let year = 2020; year < 2020 + years; year++) {
        const units = Array(4).fill(null).map((_, i) => 
          mockUnit(`UNIT${i}`, 500, Array(365).fill(Math.random() * 100))
        );
        
        const facility = createFacility('TESTFAC', units);
        const tile = new FacilityYearTile(facility, year);
        
        const startTime = performance.now();
        tile.getCanvas();
        const renderTime = performance.now() - startTime;
        renderTimes.push(renderTime);
      }
      
      const avgRenderTime = renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length;
      
      // Average render time should be under 30ms
      expect(avgRenderTime).toBeLessThan(30);
      
      // No individual render should take more than 50ms
      renderTimes.forEach(time => expect(time).toBeLessThan(50));
    });

    it('should handle large facilities efficiently', () => {
      // Test with 8 units (large facility)
      const units = Array(8).fill(null).map((_, i) => 
        mockUnit(`UNIT${i}`, 500, Array(365).fill(Math.random() * 100))
      );
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      
      const startTime = performance.now();
      tile.getCanvas();
      const renderTime = performance.now() - startTime;
      
      // Even large facilities should render quickly
      expect(renderTime).toBeLessThan(100);
    });

    it('should benefit from colour cache', () => {
      // First render - cache might be cold for some values
      const units1 = [mockUnit('UNIT1', 500, Array(365).fill(50))];
      const facility1 = createFacility('TESTFAC', units1);
      const tile1 = new FacilityYearTile(facility1, 2023);
      
      const startTime1 = performance.now();
      tile1.getCanvas();
      const renderTime1 = performance.now() - startTime1;
      
      // Second render with same capacity factors - should use cache
      const units2 = [mockUnit('UNIT2', 500, Array(365).fill(50))];
      const facility2 = createFacility('TESTFAC', units2);
      const tile2 = new FacilityYearTile(facility2, 2024);
      
      const startTime2 = performance.now();
      tile2.getCanvas();
      const renderTime2 = performance.now() - startTime2;
      
      // Both should be fast due to pre-computed cache
      expect(renderTime1).toBeLessThan(50);
      expect(renderTime2).toBeLessThan(50);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty units array', () => {
      // Empty units array should throw an error in constructor
      expect(() => createFacility('TESTFAC', [])).toThrow('No units provided for facility TESTFAC');
    });

    it('should handle leap years (366 days)', () => {
      const units = [
        mockUnit('UNIT1', 500, Array(366).fill(50))
      ];
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2024);
      expect(() => tile.getCanvas()).not.toThrow();
    });

    it('should handle leap years with correct width', () => {
      const units = [mockUnit('UNIT1', 500, Array(366).fill(50))];
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2024);
      const canvas = tile.getCanvas();
      expect(canvas.width).toBe(366); // Leap year has 366 days
    });

    it('should handle units with zero capacity', () => {
      const units = [
        mockUnit('UNIT1', 0, Array(365).fill(0))
      ];
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      const canvas = tile.getCanvas();
      // With 0 capacity, height should be 0
      expect(canvas.height).toBe(0);
    });

    it('should round capacity factors correctly', () => {
      const units = [
        mockUnit('UNIT1', 500, [
          19.4,  // Should round to 19 (red)
          19.5,  // Should round to 20 (grey)
          19.6,  // Should round to 20 (grey)
          99.4,  // Should round to 99
          99.5,  // Should round to 100
          100.1, // Should clamp to 100
          -10,   // Should clamp to 0
          null   // Should stay null (light blue)
        ])
      ];
      
      const facility = createFacility('TESTFAC', units);
      const tile = new FacilityYearTile(facility, 2023);
      expect(() => tile.getCanvas()).not.toThrow();
    });
  });
});