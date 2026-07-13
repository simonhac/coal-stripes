const baseConfig = require('./jest.config.js');

module.exports = {
  ...baseConfig,
  displayName: 'Unit Tests',
  testPathIgnorePatterns: [
    '/node_modules/',
    // Integration tests hit the live server / real API — they run via
    // jest.config.integration.js, not in the fast parallel unit suite.
    '\\.integration\\.test\\.ts$',
    '/helpers/'
  ],
  testTimeout: 5000 // 5 seconds for unit tests
};