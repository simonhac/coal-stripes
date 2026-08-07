const baseConfig = require('./jest.config.cjs');

module.exports = {
  ...baseConfig,
  displayName: 'Unit Tests',
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration tests hit the live server / real API — they run via
    // jest.config.integration.cjs, not in the fast parallel unit suite.
    '\\.integration\\.test\\.ts$',
    '/helpers/'
  ],
  testTimeout: 5000 // 5 seconds for unit tests
};