import { CapFacDataService } from '@/server/cap-fac-data-service';
import { setupTestLogger } from '../test-helpers';
import { cleanupRequestLogger } from '@/server/request-logger';

describe('Unit Sorting Integration Test', () => {
  let coalDataService: CapFacDataService;
  
  beforeAll(() => {
    // Initialize logger for tests
    setupTestLogger();
    
    const apiKey = process.env.OPENELECTRICITY_API_KEY;
    if (!apiKey) {
      throw new Error('OPENELECTRICITY_API_KEY environment variable is required for integration tests');
    }
    coalDataService = new CapFacDataService(apiKey);
  });

  afterAll(async () => {
    if (coalDataService) {
      await coalDataService.cleanup();
    }
    // Clean up the request logger to stop the interval
    cleanupRequestLogger();
  });

  test('should sort units by network, region, facility, then duid', async () => {
    console.log('\n🔄 Testing unit sorting with REAL API...');
    
    // Fetch a full year to get all units
    const result = await coalDataService.getCapacityFactors(2023);
    
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeGreaterThan(40); // Should have many coal units
    
    // Extract the unit order for verification
    const unitOrder = result.data.map(u => ({
      network: u.network,
      region: u.region || 'N/A',
      facility: u.facility_name,
      duid: u.duid
    }));
    
    console.log(`\n📊 Found ${unitOrder.length} units, showing first 10:`);
    unitOrder.slice(0, 10).forEach((u, i) => {
      console.log(`${i + 1}. ${u.network} | ${u.region.padEnd(4)} | ${u.facility.padEnd(30)} | ${u.duid}`);
    });
    
    // Verify sorting order
    for (let i = 1; i < unitOrder.length; i++) {
      const prev = unitOrder[i - 1];
      const curr = unitOrder[i];
      
      // First check network order (NEM should come before WEM)
      if (prev.network !== curr.network) {
        expect(prev.network.localeCompare(curr.network)).toBeLessThan(0);
        continue;
      }
      
      // Within same network, check region order
      if (prev.region !== curr.region) {
        expect(prev.region.localeCompare(curr.region)).toBeLessThanOrEqual(0);
        continue;
      }
      
      // Within same region, check facility order
      if (prev.facility !== curr.facility) {
        expect(prev.facility.localeCompare(curr.facility)).toBeLessThanOrEqual(0);
        continue;
      }
      
      // Within same facility, check DUID order
      expect(prev.duid.localeCompare(curr.duid)).toBeLessThan(0);
    }
    
    // Check we have units from different networks and regions
    const networks = new Set(unitOrder.map(u => u.network));
    const regions = new Set(unitOrder.filter(u => u.region !== 'N/A').map(u => u.region));
    
    console.log(`\n✅ Networks found: ${Array.from(networks).join(', ')}`);
    console.log(`✅ Regions found: ${Array.from(regions).sort().join(', ')}`);
    
    expect(networks.has('nem')).toBe(true);
    expect(networks.has('wem')).toBe(true);
    expect(regions.size).toBeGreaterThan(3); // Should have NSW1, QLD1, VIC1, etc.
  }, 15000); // 15 second timeout
});