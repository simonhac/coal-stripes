import { CapFacDataService } from '@/server/cap-fac-data-service';
import { setupTestLogger } from '../test-helpers';
import { cleanupRequestLogger } from '@/server/request-logger';

describe('CapFacDataService - Facility Filtering', () => {
  let service: CapFacDataService;

  beforeAll(() => {
    // Initialize logger for tests
    setupTestLogger();
    
    // Use environment variable for API key
    const apiKey = process.env.OPENELECTRICITY_API_KEY;
    if (!apiKey) {
      throw new Error('OPENELECTRICITY_API_KEY environment variable is required for tests');
    }
    service = new CapFacDataService(apiKey);
  });

  afterAll(async () => {
    // Clean up the service
    if (service) {
      await service.cleanup();
    }
    // Clean up the request logger to stop the interval
    cleanupRequestLogger();
  });

  test('should only return facilities with coal units', async () => {
    // Access the private method through reflection for testing
    const coalFacilities = await (service as any).getAllCoalFacilities('current');
    
    console.log(`Facility filter test: Found ${coalFacilities.length} coal facilities`);
    
    // Check that every facility has only coal units
    coalFacilities.forEach((facility: any) => {
      facility.units.forEach((unit: any) => {
        expect(unit.unit_fueltech).toMatch(/^coal_(black|brown)$/);
      });
    });
    
    expect(coalFacilities.length).toBeGreaterThan(10); // Should have many facilities
  });

  test('should analyse facility data', async () => {
    const coalFacilities = await (service as any).getAllCoalFacilities('current');
    
    // Group by region
    const regionGroups: Record<string, any[]> = {};
    let totalUnits = 0;
    let mixedFuelCount = 0;
    
    coalFacilities.forEach((facility: any) => {
      const region = facility.facility_region;
      if (!regionGroups[region]) regionGroups[region] = [];
      regionGroups[region].push(facility);
      
      totalUnits += facility.units.length;
      
      // Check for mixed fueltechs within a facility
      const fueltechs = [...new Set(facility.units.map((u: any) => u.unit_fueltech))];
      if (fueltechs.length > 1) mixedFuelCount++;
    });
    
    // Summary
    const regionSummary = Object.entries(regionGroups)
      .map(([region, facilities]) => `${region}: ${facilities.length}`)
      .join(', ');
    
    console.log(`Facility analysis: ${coalFacilities.length} facilities (${regionSummary})`);
    console.log(`  • Total units: ${totalUnits}`);
    
    if (mixedFuelCount > 0) {
      console.log(`  • ${mixedFuelCount} facilities have mixed fuel types`);
    }
    
    expect(coalFacilities.length).toBeGreaterThan(10); // Should have many facilities
    expect(totalUnits).toBeGreaterThan(40); // Should have many units
  });
});