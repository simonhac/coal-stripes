/**
 * Jest stand-in for the `cloudflare:workers` built-in module.
 *
 * Jest runs in Node, where this module does not exist. Phase 4 replaces Jest
 * with @cloudflare/vitest-pool-workers, which runs tests inside workerd and
 * provides the real thing — at which point this file goes away.
 *
 * `exports.default.fetch` forwards to global `fetch` with the URL as a string,
 * which is what lets existing tests keep mocking `global.fetch` to intercept the
 * per-year loopback.
 */
module.exports = {
  env: process.env,

  cache: {
    purge: async () => ({ success: true, errors: [] }),
  },

  exports: {
    default: {
      fetch: (request) =>
        globalThis.fetch(typeof request === 'string' ? request : request.url),
    },
  },

  waitUntil: () => {},
};
