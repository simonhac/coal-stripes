/**
 * Performance monitoring utility for tracking render times, data processing, and other metrics
 */
import { PERF_CONFIG } from '@/shared/config';

export interface PerformanceMetric {
  name: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: PerformanceMetric[] = [];
  private activeMarks = new Map<string, number>();
  private frameTimeBuffer: number[] = [];
  private lastFrameTime = 0;
  private enabled = true;

  private constructor() {
    // Start FPS monitoring only in browser environment
    if (typeof window !== 'undefined') {
      this.monitorFrameRate();
    }
  }

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  /**
   * Start timing a specific operation
   */
  start(name: string, metadata?: Record<string, any>): void {
    if (!this.enabled) return;
    
    const markName = `${name}_${Date.now()}`;
    this.activeMarks.set(markName, performance.now());
    
    if (metadata) {
      console.log(`⏱️ START: ${name}`, metadata);
    }
  }

  /**
   * End timing and record the metric
   */
  end(name: string, metadata?: Record<string, any>): number {
    if (!this.enabled) return 0;
    
    const endTime = performance.now();
    let duration = 0;
    
    // Find the most recent mark for this name
    for (const [markName, startTime] of this.activeMarks.entries()) {
      if (markName.startsWith(`${name}_`)) {
        duration = endTime - startTime;
        this.activeMarks.delete(markName);
        
        const metric: PerformanceMetric = {
          name,
          duration,
          timestamp: Date.now(),
          metadata
        };
        
        this.metrics.push(metric);
        
        // Log slow operations
        if (duration > PERF_CONFIG.SLOW_OPERATION_THRESHOLD) { // Slower than 60fps
          console.warn(`⚠️ SLOW: ${name} took ${duration.toFixed(2)}ms`, metadata);
        }

        break;
      }
    }
    
    return duration;
  }

  /**
   * Measure a synchronous operation
   */
  measure<T>(name: string, fn: () => T, metadata?: Record<string, any>): T {
    this.start(name, metadata);
    try {
      const result = fn();
      this.end(name, metadata);
      return result;
    } catch (error) {
      this.end(name, { ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Measure an async operation
   */
  async measureAsync<T>(name: string, fn: () => Promise<T>, metadata?: Record<string, any>): Promise<T> {
    this.start(name, metadata);
    try {
      const result = await fn();
      this.end(name, metadata);
      return result;
    } catch (error) {
      this.end(name, { ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Monitor frame rate
   */
  private monitorFrameRate(): void {
    const measureFrame = (currentTime: number) => {
      if (this.lastFrameTime !== 0) {
        const frameDuration = currentTime - this.lastFrameTime;
        this.frameTimeBuffer.push(frameDuration);
        
        // Keep only last 60 frames
        if (this.frameTimeBuffer.length > PERF_CONFIG.FPS_BUFFER_SIZE) {
          this.frameTimeBuffer.shift();
        }
      }
      
      this.lastFrameTime = currentTime;
      requestAnimationFrame(measureFrame);
    };
    
    requestAnimationFrame(measureFrame);
  }

  /**
   * Get current FPS
   */
  getCurrentFPS(): number {
    if (this.frameTimeBuffer.length === 0) return 0;
    
    const avgFrameTime = this.frameTimeBuffer.reduce((a, b) => a + b, 0) / this.frameTimeBuffer.length;
    return 1000 / avgFrameTime;
  }

  /**
   * Get metrics summary
   */
  getSummary(): Record<string, { count: number; avgDuration: number; totalDuration: number }> {
    const summary: Record<string, { count: number; avgDuration: number; totalDuration: number }> = {};
    
    for (const metric of this.metrics) {
      if (!summary[metric.name]) {
        summary[metric.name] = { count: 0, avgDuration: 0, totalDuration: 0 };
      }
      
      summary[metric.name].count++;
      summary[metric.name].totalDuration += metric.duration;
    }
    
    // Calculate averages
    for (const name in summary) {
      summary[name].avgDuration = summary[name].totalDuration / summary[name].count;
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
    this.metrics = [];
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