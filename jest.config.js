// Shared Jest base config. Not run directly — extended by jest.config.unit.js
// (npm test) and jest.config.integration.js (npm run test:integration).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    // allowJs so the ESM-only packages below (p-queue, p-retry and their
    // dependencies) are compiled to CJS for Jest.
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(p-queue|p-timeout|p-retry|is-network-error|eventemitter3)/)',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 60000, // 60 seconds for API calls
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  }
};