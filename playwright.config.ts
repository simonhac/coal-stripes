import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the gesture navigator. Runs against a real (focused) Chromium
 * so requestAnimationFrame actually runs and pointer/wheel events carry real
 * velocity — the things a headless/background tab can't exercise.
 *
 * Needs a dev server with .env.local (OPENELECTRICITY_API_KEY) so real data
 * loads; `npx tsx env/setup.ts` provisions that. It reuses an already-running
 * dev server on this port if present.
 */

// Must match vite.config.ts, which binds `PORT || 3010` — hard-coding a port
// here instead is how this config ended up waiting on :3000 for a server that
// was listening on :3010, and timing out after two minutes.
//
// Deriving it from PORT also keeps workspaces off each other's toes: Conductor's
// @simon/workspace-env allocates each one its own port, so `reuseExistingServer`
// can't silently attach to a sibling workspace's server and test the wrong tree.
const PORT = Number(process.env.PORT) || 3010;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    // Explicit, so the server Playwright starts lands on the port we then wait
    // on even when PORT isn't already exported into the environment.
    env: { PORT: String(PORT) },
  },
});
