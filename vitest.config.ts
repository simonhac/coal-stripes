import { defineConfig } from 'vitest/config';
// v0.20 of the pool dropped the `/config` subpath and its defineWorkersProject
// helper; the pool is now passed directly as a project's `pool`.
import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Two projects, split by what the code under test actually needs.
 *
 * `unit` is the bulk of the suite: date maths, the canvas tile builder, the
 * query-key layer, DTO shaping. None of it depends on the runtime, so it runs
 * in plain Node — fast, and the canvas mock works. `cloudflare:workers` is
 * aliased to a stub there, replacing the Jest moduleNameMapper that did the
 * same job.
 *
 * `workers` runs inside **workerd** via @cloudflare/vitest-pool-workers. Its
 * value is specifically the things Node cannot show you: this is where the
 * module-level p-queue deadlock would have been caught, and the regression test
 * for it lives there.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@': src,
            'cloudflare:workers': fileURLToPath(
              new URL('./test/mocks/cloudflare-workers.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'unit',
          environment: 'node',
          // Jest injected describe/it/expect as globals and the suite relies on
          // it; keeping that avoids touching every one of the ~30 test files.
          globals: true,
          include: ['src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/helpers/**', 'src/**/workerd/**'],
          setupFiles: ['./test/setup-env.ts'],
        },
      },
      {
        // Hits the live OpenElectricity API. Excluded from the default run and
        // invoked explicitly by `test:integration`, as under Jest.
        resolve: {
          alias: {
            '@': src,
            'cloudflare:workers': fileURLToPath(
              new URL('./test/mocks/cloudflare-workers.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          include: ['src/**/*.integration.test.ts'],
          setupFiles: ['./test/setup-env.ts'],
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias: { '@': src } },
        test: {
          name: 'workers',
          globals: true,
          include: ['src/**/workerd/*.test.ts'],
          pool: cloudflarePool({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { ENABLE_FILE_LOGGING: 'false' } },
          }),
        },
      },
    ],
  },
});
