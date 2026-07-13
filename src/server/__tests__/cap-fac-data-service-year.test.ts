import { CapFacDataService } from '@/server/cap-fac-data-service';
import { parseDate } from '@internationalized/date';
import { setupTestLogger, cleanupTestLogger } from '../test-helpers';

// Initialize logger for tests
beforeAll(() => {
  setupTestLogger();
});

// Cleanup logger after all tests
afterAll(() => {
  cleanupTestLogger();
});

// Mock the OpenElectricityClient
jest.mock('openelectricity', () => ({
  OpenElectricityClient: jest.fn().mockImplementation(() => ({
    getFacilities: jest.fn().mockResolvedValue({
      response: {},
      table: {
        getRecords: () => [
          {
            facility_code: 'ERARING',
            facility_name: 'Eraring Power Station',
            facility_network: 'NEM',
            facility_region: 'NSW1',
            unit_code: 'ER01',
            unit_fueltech: 'coal_black',
            unit_capacity: 720
          },
          {
            facility_code: 'BAYSW',
            facility_name: 'Bayswater Power Station',
            facility_network: 'NEM',
            facility_region: 'NSW1',
            unit_code: 'BW01',
            unit_fueltech: 'coal_black',
            unit_capacity: 660
          }
        ]
      }
    }),
    getFacilityData: jest.fn().mockImplementation((_network: any, facilityCodes: string[], _metrics: any, options: any) => {
      // Generate mock daily rows for the requested (exclusive-end) range.
      const startDate = parseDate(options.dateStart);
      const endDate = parseDate(options.dateEnd).subtract({ days: 1 }); // API end date is exclusive
      const rows: any[] = [];

      let currentDate = startDate;
      while (currentDate.compare(endDate) <= 0) {
        facilityCodes.forEach((facilityCode: string) => {
          const unit_code = facilityCode === 'ERARING' ? 'ER01' : 'BW01';
          rows.push({
            // The client returns each day as the instant of NEM-local
            // (AEST, UTC+10) midnight — as a Date, not a string.
            interval: new Date(`${currentDate.toString()}T00:00:00+10:00`),
            unit_code,
            energy: 15000 + Math.random() * 1000
          });
        });
        currentDate = currentDate.add({ days: 1 });
      }

      return Promise.resolve({ datatable: { getRows: () => rows } });
    })
  }))
}));

describe('CapFacDataService - Year-based Fetching', () => {
  let service: CapFacDataService;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new CapFacDataService('test-api-key');
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    jest.clearAllMocks();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe('Data Structure', () => {
    test('should return properly structured coal stripes data', async () => {
      const result = await service.getCapacityFactors(2023);
      
      // Check structure
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('created_at');
      expect(result.data).toBeInstanceOf(Array);
      expect(result.data.length).toBeGreaterThan(0);
      
      // Check created_at is in AEST timezone format (without timezone identifier or milliseconds)
      expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+10:00$/);
      // Verify it contains the timezone offset
      expect(result.created_at).toContain('+10:00');
      expect(result.created_at).not.toContain('[Australia/Brisbane]');
      expect(result.created_at).not.toContain('.');
      
      // Check first unit structure
      const firstUnit = result.data[0];
      expect(firstUnit).toHaveProperty('network');
      expect(firstUnit).toHaveProperty('region');
      expect(firstUnit).toHaveProperty('duid');
      expect(firstUnit).toHaveProperty('facility_name');
      expect(firstUnit).toHaveProperty('capacity');
      expect(firstUnit).toHaveProperty('history');
      expect(firstUnit.history).toHaveProperty('data');
      expect(firstUnit.history).toHaveProperty('start');
      expect(firstUnit.history).toHaveProperty('last');
      
      // Check unit data
      expect(firstUnit.history.data).toBeInstanceOf(Array);
      expect(firstUnit.history.data.length).toBe(365);
      
      // Check that data contains numbers or nulls
      const sampleValue = firstUnit.history.data[0];
      expect(typeof sampleValue === 'number' || sampleValue === null).toBe(true);
    });

    test('returns a full leap year (366 days) from a single fetch', async () => {
      const result = await service.getCapacityFactors(2024);
      expect(result.data[0].history.data.length).toBe(366);
      expect(result.data[0].history.start).toBe('2024-01-01');
      expect(result.data[0].history.last).toBe('2024-12-31');
      // Feb 29 is at index 59 and must carry a value (this is a past leap year).
      expect(result.data[0].history.data[59]).not.toBeNull();
    });
  });
});