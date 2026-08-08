import { vi } from 'vitest';
import { initializeRequestLogger, cleanupRequestLogger } from './request-logger';

// Initialize the request logger for tests
export function setupTestLogger(): void {
  // Use a test port number
  initializeRequestLogger(9999);
}

// Cleanup the request logger after tests
export function cleanupTestLogger(): void {
  cleanupRequestLogger();
}

// Helper to mock the request logger for tests that don't need real logging
export function mockRequestLogger(): void {
  vi.mock('../request-logger', () => ({
    initializeRequestLogger: vi.fn(),
    getRequestLogger: vi.fn(() => ({
      getNextRequestId: vi.fn(() => 'ID1'),
      log: vi.fn(),
      cleanOldLogs: vi.fn()
    }))
  }));
}