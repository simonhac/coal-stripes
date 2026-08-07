/**
 * Request logging for the OpenElectricity client.
 *
 * Previously this appended lines to daily files under `logs/` with
 * `fs.appendFileSync`. That cannot survive the move to workerd: there is no
 * filesystem, and — more immediately — `import * as fs from 'fs'` at module
 * scope breaks bundling regardless of whether the writes ever execute, because
 * `queued-oeclient.ts` imports this module statically. The `ENABLE_FILE_LOGGING`
 * gate did not save it; only removing the import does.
 *
 * The replacement writes one structured JSON line per event to `console`, which
 * Workers Logs and Logpush pick up and index. Same call sites, same event
 * vocabulary, no I/O.
 */

import { readEnv } from '@/server/runtime-env';

export type LogEventType =
  | 'QUEUED'
  | 'STARTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRY'
  | 'CIRCUIT_OPEN'
  | 'CIRCUIT_CLOSED';

export interface LogEntry {
  timestamp: Date;
  eventType: LogEventType;
  requestId?: string;
  method?: string;
  path?: string;
  priority?: number;
  attempt?: number;
  maxAttempts?: number;
  status?: number;
  duration?: number;
  size?: string;
  error?: string;
  delay?: number;
  threshold?: number;
  failures?: number;
  resetIn?: number;
}

/**
 * Set `ENABLE_FILE_LOGGING=false` to silence request logging entirely. The name
 * is kept for continuity with `.env.local`, though nothing writes to a file any
 * more; unset means on.
 */
function loggingEnabled(): boolean {
  return readEnv('ENABLE_FILE_LOGGING') !== 'false';
}

export class RequestLogger {
  private requestCounter = 0;
  public readonly fileLoggingEnabled: boolean;

  constructor(public readonly port: number) {
    this.fileLoggingEnabled = loggingEnabled();
  }

  public getNextRequestId(): string {
    this.requestCounter++;
    return `ID${this.requestCounter}`;
  }

  public log(entry: LogEntry): void {
    if (!this.fileLoggingEnabled) return;

    const { timestamp, eventType, ...rest } = entry;

    // Drop undefined fields so each line carries only what the event set —
    // the old format did the same by appending only the keys it had.
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) fields[key] = value;
    }

    console.log(
      JSON.stringify({
        log: 'oe-request',
        at: timestamp.toISOString(),
        event: eventType,
        ...fields,
      }),
    );
  }

  /** Retained so callers don't change; log retention is Cloudflare's problem now. */
  public cleanOldLogs(): void {}
}

let loggerInstance: RequestLogger | null = null;

export function initializeRequestLogger(port: number): void {
  if (!loggerInstance) loggerInstance = new RequestLogger(port);
}

/**
 * The logger used by the OpenElectricity client, initialising itself on first
 * use if nobody has done so explicitly.
 *
 * This used to throw instead, which made it a trap: the only explicit
 * initialisation lived at module scope in the capacity-factors route, so any
 * code path that reached the OE client without that module having been loaded
 * died. The cron warmer hit exactly this. Self-initialising is what makes the
 * route's module-scope call unnecessary — which matters now, because module
 * scope in a Worker runs at isolate startup, not per request.
 */
export function getRequestLogger(): RequestLogger {
  if (!loggerInstance) initializeRequestLogger(0);
  return loggerInstance!;
}

export function cleanupRequestLogger(): void {
  loggerInstance = null;
}
