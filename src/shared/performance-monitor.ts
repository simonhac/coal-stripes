/**
 * Performance monitoring utility for tracking render times, data processing, and
 * other metrics.
 *
 * Two properties matter more than anything this measures, because this thing
 * sits in the per-frame paint path (CompositeTile calls it around every row's
 * repaint, ~50 rows a frame during a pan):
 *
 *  - **It is bounded.** The recent-metric log is a fixed-size ring buffer and
 *    the summary is a running aggregate, so nothing here grows with time spent
 *    panning. The previous version pushed every metric into an unbounded array
 *    and re-walked the whole thing from a 2 Hz poll, which made a long session
 *    measurably slower than a fresh one — the monitor became the thing worth
 *    monitoring.
 *  - **It is off unless asked for.** Gated on the `perfMonitor` feature flag,
 *    which defaults to false, so an ordinary visitor pays a boolean test per
 *    call and nothing else. Toggle it from the Shift+P overlay's Features tab
 *    (the flag store lists any flag that has been read, so it appears there
 *    without further wiring).
 *
 * Marks are identified by an opaque token from start(), not by name. Names
 * collided: the old key was `${name}_${Date.now()}`, so the ~50 rows painting
 * within one millisecond all wrote the same key, the first end() consumed it and
 * the other 49 recorded nothing — the overlay's per-row timings were a 1-in-50
 * sample presented as an average.
 */
import { PERF_CONFIG } from '@/shared/config';
import { featureFlags } from '@/shared/feature-flags';

export interface PerformanceMetric {
  name: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

/** Opaque handle returned by start() and consumed by end(). */
export type PerfMark = number;

/** The feature flag that arms the monitor. Off unless a developer turns it on. */
export const PERF_MONITOR_FLAG = 'perfMonitor';

/** How many recent metrics to retain. Only generateReport() reads them. */
const METRIC_LOG_SIZE = 500;

/**
 * Stop the frame-rate loop once nothing has asked for the number in this long.
 * The only consumer is the overlay's 500 ms poll, so a couple of missed polls
 * means it has gone away and a permanent rAF loop would be pure overhead.
 */
const FPS_IDLE_TIMEOUT_MS = 2000;

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;

  /** Ring buffer of recent metrics; `count` is the total ever recorded. */
  private log: PerformanceMetric[] = [];
  private logWriteIndex = 0;

  /** Running per-name aggregate, so getSummary() is O(names), not O(metrics). */
  private totals = new Map<string, { count: number; totalDuration: number }>();

  private activeMarks = new Map<PerfMark, { name: string; startTime: number }>();
  private nextMark: PerfMark = 1;

  private frameTimeBuffer: number[] = [];
  private lastFrameTime = 0;
  private frameLoopRunning = false;
  private lastFpsPoll = 0;

  private enabled = false;

  private constructor() {
    this.enabled = featureFlags.get(PERF_MONITOR_FLAG);
    featureFlags.subscribe(() => {
      this.enabled = featureFlags.get(PERF_MONITOR_FLAG);
    });
  }

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Start timing an operation. Returns a token to hand to end(), or null when
   * the monitor is disarmed — which callers can use to skip end() entirely.
   */
  start(name: string, metadata?: Record<string, any>): PerfMark | null {
    if (!this.enabled) return null;

    const mark = this.nextMark++;
    this.activeMarks.set(mark, { name, startTime: performance.now() });

    if (metadata) {
      console.log(`⏱️ START: ${name}`, metadata);
    }

    return mark;
  }

  /** End a timing started by start(), record it, and return its duration. */
  end(mark: PerfMark | null, metadata?: Record<string, any>): number {
    if (mark === null) return 0;

    const active = this.activeMarks.get(mark);
    if (!active) return 0;
    this.activeMarks.delete(mark);

    const duration = performance.now() - active.startTime;
    this.record(active.name, duration, metadata);

    if (duration > PERF_CONFIG.SLOW_OPERATION_THRESHOLD) {
      console.warn(`⚠️ SLOW: ${active.name} took ${duration.toFixed(2)}ms`, metadata);
    }

    return duration;
  }

  /** Measure a synchronous operation. */
  measure<T>(name: string, fn: () => T, metadata?: Record<string, any>): T {
    const mark = this.start(name, metadata);
    try {
      const result = fn();
      this.end(mark, metadata);
      return result;
    } catch (error) {
      this.end(mark, { ...metadata, error: true });
      throw error;
    }
  }

  /** Measure an async operation. */
  async measureAsync<T>(name: string, fn: () => Promise<T>, metadata?: Record<string, any>): Promise<T> {
    const mark = this.start(name, metadata);
    try {
      const result = await fn();
      this.end(mark, metadata);
      return result;
    } catch (error) {
      this.end(mark, { ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Fold one measurement into the running aggregate and the recent-metric ring.
   *
   * The aggregate is what getSummary() reports and it is exact over the whole
   * session; the ring is a bounded window kept only so generateReport() can show
   * recent detail. Neither grows.
   */
  private record(name: string, duration: number, metadata?: Record<string, any>): void {
    const total = this.totals.get(name);
    if (total) {
      total.count++;
      total.totalDuration += duration;
    } else {
      this.totals.set(name, { count: 1, totalDuration: duration });
    }

    const metric: PerformanceMetric = {
      name,
      duration,
      timestamp: Date.now(),
      metadata,
    };

    if (this.log.length < METRIC_LOG_SIZE) {
      this.log.push(metric);
    } else {
      this.log[this.logWriteIndex] = metric;
    }
    this.logWriteIndex = (this.logWriteIndex + 1) % METRIC_LOG_SIZE;
  }

  /**
   * Frame-rate sampling, started on demand by getCurrentFPS() and stopped again
   * once nothing is polling. Independent of `enabled`: the overlay's FPS readout
   * is useful precisely when the per-operation timings are turned off, and one
   * rAF that subtracts two numbers is not what costs frames.
   */
  private startFrameRateLoop(): void {
    if (this.frameLoopRunning || typeof window === 'undefined') return;
    this.frameLoopRunning = true;
    this.lastFrameTime = 0;

    const measureFrame = (currentTime: number) => {
      if (performance.now() - this.lastFpsPoll > FPS_IDLE_TIMEOUT_MS) {
        this.frameLoopRunning = false;
        return;
      }

      if (this.lastFrameTime !== 0) {
        this.frameTimeBuffer.push(currentTime - this.lastFrameTime);
        if (this.frameTimeBuffer.length > PERF_CONFIG.FPS_BUFFER_SIZE) {
          this.frameTimeBuffer.shift();
        }
      }

      this.lastFrameTime = currentTime;
      requestAnimationFrame(measureFrame);
    };

    requestAnimationFrame(measureFrame);
  }

  /** Current FPS. Asking for it is what keeps the sampling loop alive. */
  getCurrentFPS(): number {
    this.lastFpsPoll = typeof performance !== 'undefined' ? performance.now() : 0;
    this.startFrameRateLoop();

    if (this.frameTimeBuffer.length === 0) return 0;

    const avgFrameTime =
      this.frameTimeBuffer.reduce((a, b) => a + b, 0) / this.frameTimeBuffer.length;
    return 1000 / avgFrameTime;
  }

  /** Metrics summary, from the running aggregate. */
  getSummary(): Record<string, { count: number; avgDuration: number; totalDuration: number }> {
    const summary: Record<string, { count: number; avgDuration: number; totalDuration: number }> = {};

    for (const [name, { count, totalDuration }] of this.totals) {
      summary[name] = {
        count,
        totalDuration,
        avgDuration: totalDuration / count,
      };
    }

    return summary;
  }

  /**
   * Get memory usage info
   */
  getMemoryInfo(): { heapUsed: number; heapTotal: number; heapLimit: number } | null {
    // Check for browser environment and Chrome-specific API
    if (typeof window !== 'undefined' && typeof performance !== 'undefined') {
      // @ts-ignore - performance.memory is non-standard but available in Chrome
      const perfWithMemory = performance as any;
      if (perfWithMemory.memory) {
        return {
          heapUsed: perfWithMemory.memory.usedJSHeapSize / 1048576, // Convert to MB
          heapTotal: perfWithMemory.memory.totalJSHeapSize / 1048576,
          heapLimit: perfWithMemory.memory.jsHeapSizeLimit / 1048576
        };
      }
    }
    return null;
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.log = [];
    this.logWriteIndex = 0;
    this.totals.clear();
    this.activeMarks.clear();
    this.frameTimeBuffer = [];
  }

  /**
   * Generate performance report
   */
  generateReport(): string {
    const summary = this.getSummary();
    const fps = this.getCurrentFPS();
    const memory = this.getMemoryInfo();

    let report = '📊 PERFORMANCE REPORT\n';
    report += '=' .repeat(50) + '\n\n';

    if (!this.enabled) {
      report += `⚠️  Operation timing is OFF — enable the "${PERF_MONITOR_FLAG}" feature flag.\n\n`;
    }

    report += `🎯 Current FPS: ${fps.toFixed(1)}\n`;
    if (memory) {
      report += `💾 Memory: ${memory.heapUsed.toFixed(1)}MB / ${memory.heapTotal.toFixed(1)}MB (Limit: ${memory.heapLimit.toFixed(1)}MB)\n`;
    }
    report += '\n';

    report += '⏱️ Operation Timings:\n';
    report += '-' .repeat(50) + '\n';

    // Sort by total duration
    const sortedOps = Object.entries(summary)
      .sort(([, a], [, b]) => b.totalDuration - a.totalDuration);

    for (const [name, stats] of sortedOps) {
      report += `${name}:\n`;
      report += `  Count: ${stats.count}\n`;
      report += `  Avg: ${stats.avgDuration.toFixed(2)}ms\n`;
      report += `  Total: ${stats.totalDuration.toFixed(2)}ms\n`;
      report += '\n';
    }

    return report;
  }

  /**
   * Log report to console
   */
  logReport(): void {
    console.log(this.generateReport());
  }
}

// Export singleton instance
export const perfMonitor = PerformanceMonitor.getInstance();
