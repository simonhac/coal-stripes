/**
 * Stand-in for the `cloudflare:workers` built-in, for tests that run in Node.
 *
 * The `workers` vitest project runs inside workerd and gets the real module;
 * this is only aliased in for the `unit` project, whose tests are about data
 * shaping rather than runtime behaviour.
 *
 * `exports.default.fetch` forwards to global `fetch` with the URL as a string,
 * which is what lets a test stub `global.fetch` and intercept the per-year
 * loopback in coal-stats-service.
 */
export const env: Record<string, unknown> = {
  ...(typeof process !== 'undefined' ? process.env : {}),
  // Keep the loopback path live so tests exercise it; the transport below is
  // what they actually stub.
  CF_LOOPBACK: 'on',
};

export const cache = {
  purge: async () => ({ success: true, errors: [] as unknown[] }),
};

export const exports = {
  default: {
    fetch: (request: Request | string) =>
      globalThis.fetch(typeof request === 'string' ? request : request.url),
  },
};

export function waitUntil(): void {}
