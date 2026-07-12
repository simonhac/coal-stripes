import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the gesture navigator. Runs against a real (focused) Chromium
 * so requestAnimationFrame actually runs and pointer/wheel events carry real
 * velocity — the things a headless/background tab can't exercise.
 *
 * Needs a dev server with .env.local (OPENELECTRICITY_API_KEY) so real data
 * loads; `npx tsx env/setup.ts` provisions that. It reuses an already-running
 * dev server on :3000 if present.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
