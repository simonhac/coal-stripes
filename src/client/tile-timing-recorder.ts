/**
 * Tile Timing Recorder — a bounded, in-browser log of how long each tile render
 * took.
 *
 * "Tile render" spans three kinds of work:
 *  - `tile-build`  — building one facility's canvas for one year (FacilityYearTile).
 *  - `year-build`  — building every facility tile for a year (createCapFacYear).
 *  - `fetch-build` — the end-to-end query: network fetch + JSON parse + year build.
 *  - `reslice`     — reserved for the per-frame CompositeTile reslice (already
 *                    tracked by perfMonitor; not emitted here to keep this log
 *                    focused on actual tile renders rather than high-frequency
 *                    reslicing).
 *
 * These timings live ONLY in this browser tab's JS heap — there is no server
 * persistence — so they are surfaced on the /diagnostics page and the Shift+P
 * overlay, both of which read this singleton. Records accumulate as the user
 * navigates the visualisation; a fresh page load (or a new tab) starts empty.
 *
 * Pub/sub mirrors tile-monitor.ts. Uses only performance.now() / Date.now()
 * (both plain numbers, SSR-safe); `at` is formatted to AEST only at display time.
 */

export type TileTimingKind = 'tile-build' | 'year-build' | 'fetch-build' | 'reslice';

export interface TileTimingRecord {
  kind: TileTimingKind;
  year: number;
  facility?: string; // facilityCode — present for per-facility kinds (tile-build, reslice)
  ms: number; // performance.now() delta
  at: number; // Date.now() epoch ms; the sanctioned external-interface use of a timestamp number
}

class TileTimingRecorder {
  private static instance: TileTimingRecorder;
  private records: TileTimingRecord[] = [];
  private readonly cap = 1000; // bounded ring buffer
  private listeners = new Set<() => void>();

  private constructor() {}

  static getInstance(): TileTimingRecorder {
    if (!TileTimingRecorder.instance) {
      TileTimingRecorder.instance = new TileTimingRecorder();
    }
    return TileTimingRecorder.instance;
  }

  record(rec: TileTimingRecord): void {
    this.records.push(rec);
    if (this.records.length > this.cap) this.records.shift();
    this.notify();
  }

  /** Time a synchronous build, record it on success, and return its result. */
  time<T>(kind: TileTimingKind, dims: { year: number; facility?: string }, fn: () => T): T {
    const t0 = performance.now();
    const result = fn();
    this.record({ kind, year: dims.year, facility: dims.facility, ms: performance.now() - t0, at: Date.now() });
    return result;
  }

  /** Time an async build, record it on success, and return its result. */
  async timeAsync<T>(
    kind: TileTimingKind,
    dims: { year: number; facility?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    this.record({ kind, year: dims.year, facility: dims.facility, ms: performance.now() - t0, at: Date.now() });
    return result;
  }

  /** Newest-last snapshot of all retained records. */
  getRecords(): readonly TileTimingRecord[] {
    return this.records;
  }

  clear(): void {
    this.records = [];
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const tileTimingRecorder = TileTimingRecorder.getInstance();
