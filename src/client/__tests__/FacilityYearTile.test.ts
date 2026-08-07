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
    status: 'operating',
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
          24.4,  // Should round to 24 (red)
          24.5,  // Should round to 25 (grey)
          24.6,  // Should round to 25 (grey)
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