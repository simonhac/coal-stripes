/**
 * Reading configuration, from whichever place the current runtime keeps it.
 *
 * On Workers the authoritative source is `env` from `cloudflare:workers`.
 * `process.env` is a `nodejs_compat` shim that is populated in some contexts and
 * not others — under `vite dev` it came back empty, which surfaced as every year
 * of /api/stats failing with "API key not configured" while /api/health, reading
 * `env` directly, reported the key as present. Preferring `env` and falling back
 * to `process.env` covers both, and keeps Jest (plain Node, with dotenv)
 * working.
 */
import { env } from 'cloudflare:workers';

export function readEnv(name: string): string | undefined {
  const fromWorker = (env as unknown as Record<string, unknown>)?.[name];
  if (typeof fromWorker === 'string' && fromWorker !== '') return fromWorker;

  const fromProcess =
    typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return fromProcess === '' ? undefined : fromProcess;
}

/** Truthy-flag helper, for the opt-in debug switches. */
export function envFlag(name: string): boolean {
  return Boolean(readEnv(name));
}
