/**
 * Stand-in for the `cloudflare:workers` built-in, for tests that run in Node.
 *
 * The `workers` vitest project runs inside workerd and gets the real module,
 * including a real R2 binding from miniflare; this is only aliased in for the
 * `unit` project, whose tests are about data shaping rather than runtime
 * behaviour. There is deliberately no `DATA` binding here — a unit test that
 * wants to exercise the store belongs in the `workers` project, and the store
 * degrades to "no bucket" rather than pretending.
 */
export const env: Record<string, unknown> = {
  ...(typeof process !== 'undefined' ? process.env : {}),
};

export const cache = {
  purge: async () => ({ success: true, errors: [] as unknown[] }),
};

export function waitUntil(): void {}
