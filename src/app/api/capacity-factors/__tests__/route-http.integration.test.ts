/**
 * Integration tests for capacity-factors API caching
 * These tests run against a real Next.js server instance
 */

import { spawn, ChildProcess } from 'child_process';
import { getTodayAEST } from '@/shared/date-utils';

const PORT = 3001; // Use a different port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}/api/capacity-factors`;

describe('Capacity Factors API HTTP Integration Tests', () => {
  let serverProcess: ChildProcess;
  
  // Helper to wait for server to be ready
  const waitForServer = async (maxAttempts = 30): Promise<void> => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${PORT}`);
        if (response.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Server failed to start');
  };

  beforeAll(async () => {
    console.log('Starting Next.js server for integration tests...');
    
    // Start the Next.js server
    serverProcess = spawn('npm', ['run', 'dev', '--', '-p', PORT.toString()], {
      stdio: 'pipe',
      env: { ...process.env, PORT: PORT.toString() },
      detached: process.platform !== 'win32', // Create new process group on Unix
      shell: false
    });

    // Log server output for debugging
    serverProcess.stdout?.on('data', (data) => {
      if (process.env.DEBUG) console.log(`[Server] ${data}`);
    });
    
    serverProcess.stderr?.on('data', (data) => {
      if (process.env.DEBUG) console.error(`[Server Error] ${data}`);
    });

    // Wait for server to be ready
    await waitForServer();
    console.log('Server is ready!');
  }, 60000); // 60 second timeout for server startup

  afterAll(async () => {
    console.log('Shutting down server...');
    if (serverProcess) {
      // Kill the entire process tree to ensure all child processes are terminated
      try {
        // Use process group kill on Unix systems
        process.kill(-serverProcess.pid!, 'SIGTERM');
      } catch (_e) {
        // Fallback to regular kill
        serverProcess.kill('SIGTERM');
      }
      
      // Wait for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Force kill if still running
      if (!serverProcess.killed) {
        try {
          process.kill(-serverProcess.pid!, 'SIGKILL');
        } catch (_e) {
          serverProcess.kill('SIGKILL');
        }
      }
      
      // Clean up listeners
      serverProcess.stdout?.removeAllListeners();
      serverProcess.stderr?.removeAllListeners();
      serverProcess.removeAllListeners();
    }
  });

  describe('Caching Behaviour', () => {
    // Browser and edge lifetimes are set by SEPARATE headers, on purpose: the
    // browser cache is the one layer a purge can never reach, so it is capped at
    // 60 s, while the edge keeps the year's full freshness-tier window. See
    // docs/caching-and-diagnostics.md.
    const BROWSER_CACHE_CONTROL = 'public, max-age=60';

    // `x-cf-cold` is the honest "did this request pay an OpenElectricity fetch?"
    // signal, and is what these tests assert on. Wall-clock thresholds were
    // flaky: a warm Data Cache read still has to deserialise ~230 KB from disk.
    const paidColdFetch = (res: Response): boolean =>
      res.headers.get('x-cf-cold') === 'true';

    test('should cache current year requests for 1 hour', async () => {
      const currentYear = getTodayAEST().year;

      const response1 = await fetch(`${BASE_URL}?year=${currentYear}`);
      const data1 = await response1.json();

      expect(response1.status).toBe(200);
      expect(response1.headers.get('Cache-Control')).toBe(BROWSER_CACHE_CONTROL);
      expect(response1.headers.get('Vercel-CDN-Cache-Control')).toBe(
        'public, s-maxage=3600, stale-while-revalidate=86400'
      );
      expect(data1.data).toBeDefined();
      expect(data1.data.length).toBeGreaterThan(0);

      // Second request must come from the Data Cache, whatever the first did.
      const response2 = await fetch(`${BASE_URL}?year=${currentYear}`);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(paidColdFetch(response2)).toBe(false);
      expect(data2).toEqual(data1);
    }, 30000);

    test('should cache recent past years for a day (NEM data is subject to revision)', async () => {
      const previousYear = getTodayAEST().year - 1;

      const response1 = await fetch(`${BASE_URL}?year=${previousYear}`);
      const data1 = await response1.json();

      expect(response1.status).toBe(200);
      expect(response1.headers.get('Cache-Control')).toBe(BROWSER_CACHE_CONTROL);
      expect(response1.headers.get('Vercel-CDN-Cache-Control')).toBe(
        'public, s-maxage=86400, stale-while-revalidate=604800'
      );

      const response2 = await fetch(`${BASE_URL}?year=${previousYear}`);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(paidColdFetch(response2)).toBe(false);
      expect(data2).toEqual(data1);
    }, 30000);

    test('should serve concurrent requests for the same cold year identically', async () => {
      // Single-flight collapses these into ONE upstream fan-out, so every
      // response carries the same payload built at the same instant. (Note
      // x-cf-cold is true for all of them, and rightly so: each of these
      // requests really did wait on OpenElectricity. That the wait was shared
      // is asserted directly in cf-cache-single-flight.test.ts.)
      const year = 2021;
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => fetch(`${BASE_URL}?year=${year}`))
      );

      for (const res of responses) expect(res.status).toBe(200);
      const builtAt = responses.map((r) => r.headers.get('x-cf-built-at'));
      expect(new Set(builtAt).size).toBe(1);
    }, 60000);

    test('should handle future year appropriately', async () => {
      const futureYear = getTodayAEST().year + 1;
      
      const response = await fetch(`${BASE_URL}?year=${futureYear}`);
      const data = await response.json();
      
      // Future year might return 500 with "No data found" or 200 with null values
      if (response.status === 500) {
        expect(data.error).toBeDefined();
        console.log(`Future year returned error: "${data.error}"`);
      } else if (response.status === 200) {
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        // If data is returned, capacity factors should be null
        if (data.data?.[0]?.history?.data) {
          const allNull = data.data[0].history.data.every((cf: number | null) => cf === null);
          expect(allNull).toBe(true);
        }
      }
    }, 30000);

    test('should cache different years independently', async () => {
      const year1 = 2022;
      const year2 = 2023;
      
      // Warm up both caches
      await fetch(`${BASE_URL}?year=${year1}`);
      await fetch(`${BASE_URL}?year=${year2}`);

      // Now test that both are cached — one year's entry must not evict or
      // shadow the other's.
      const response1 = await fetch(`${BASE_URL}?year=${year1}`);
      const data1 = await response1.json();

      const response2 = await fetch(`${BASE_URL}?year=${year2}`);
      const data2 = await response2.json();

      expect(paidColdFetch(response1)).toBe(false);
      expect(paidColdFetch(response2)).toBe(false);

      // Data should be different
      expect(data1.data[0]?.history?.start).toContain(year1.toString());
      expect(data2.data[0]?.history?.start).toContain(year2.toString());
    }, 30000);
  });

  describe('Response Validation', () => {
    test('should return properly structured data', async () => {
      const response = await fetch(`${BASE_URL}?year=2023`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(40); // Should have many coal units
      
      // Validate unit structure
      const unit = data.data[0];
      expect(unit).toHaveProperty('duid');
      expect(unit).toHaveProperty('facility_name');
      expect(unit).toHaveProperty('network');
      expect(unit).toHaveProperty('capacity');
      expect(unit).toHaveProperty('history');
      
      // Validate history structure
      expect(unit.history).toHaveProperty('data');
      expect(unit.history).toHaveProperty('start');
      expect(unit.history).toHaveProperty('last');
      expect(unit.history).toHaveProperty('interval');
      expect(Array.isArray(unit.history.data)).toBe(true);
      expect(unit.history.data.length).toBe(365); // 2023 is not a leap year
    }, 30000);

    test('should handle invalid year parameters', async () => {
      // Missing year
      const response1 = await fetch(`${BASE_URL}`);
      expect(response1.status).toBe(400);
      const data1 = await response1.json();
      expect(data1.error).toBe('Year parameter is required');
      
      // Invalid year
      const response2 = await fetch(`${BASE_URL}?year=invalid`);
      expect(response2.status).toBe(400);
      const data2 = await response2.json();
      expect(data2.error).toBe('Invalid year parameter');
      
      // Year too old
      const response3 = await fetch(`${BASE_URL}?year=1899`);
      expect(response3.status).toBe(400);
      
      // Year too far in future
      const response4 = await fetch(`${BASE_URL}?year=2101`);
      expect(response4.status).toBe(400);
    }, 30000);
  });
});