const baseConfig = require('./jest.config.cjs');

module.exports = {
  ...baseConfig,
  displayName: 'Integration Tests',
  testMatch: [
    '**/*.integration.test.ts'
  ],
  testTimeout: 15000, // 15 seconds for API calls
  reporters: [
    'default',
    ['<rootDir>/jest-slow-test-reporter.cjs', { slowThreshold: 2000 }]
  ],
  forceExit: true // Force Jest to exit after tests complete
};