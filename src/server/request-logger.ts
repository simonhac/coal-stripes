import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '@/shared/request-queue-logger';

export type { LogEntry };

export class RequestLogger {
  private logDir: string;
  private port: number;
  private requestCounter: number = 0;
  private currentLogFile: string | null = null;
  private currentDate: string | null = null;
  public readonly fileLoggingEnabled: boolean;

  constructor(port: number) {
    this.port = port;
    this.logDir = path.join(process.cwd(), 'logs');
    
    // Check if file logging is enabled via environment variable
    // Default to true for development, false for production
    this.fileLoggingEnabled = process.env.ENABLE_FILE_LOGGING === 'true' || 
                             (process.env.ENABLE_FILE_LOGGING !== 'false' && process.env.NODE_ENV === 'development');
    
    if (this.fileLoggingEnabled) {
      this.ensureLogDirectory();
      this.initializeLogFile();
    }
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private initializeLogFile(): void {
    // Get the initial log file name
    const logFile = path.join(this.logDir, this.getLogFileName());
    
    // Write the opening log entry
    const timestamp = this.formatTimestamp(new Date());
    const logLine = `${timestamp} [LOG_OPENED] port=${this.port} pid=${process.pid}\n`;
    
    fs.appendFileSync(logFile, logLine);
  }

  private getLogFileName(): string {
    const now = new Date();
    const dateStr = this.formatDate(now);
    
    // Check if we need a new log file (date changed)
    if (dateStr !== this.currentDate) {
      this.currentDate = dateStr;
      const timeStr = this.formatTime(now);
      this.currentLogFile = `${dateStr}_${timeStr}_capfac_${this.port}.log`;
      this.requestCounter = 0; // Reset counter for new day
    }
    
    return this.currentLogFile!;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  private formatTime(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}${minutes}${seconds}`;
  }

  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
  }

  public getNextRequestId(): string {
    this.requestCounter++;
    return `ID${this.requestCounter}`;
  }

  public log(entry: LogEntry): void {
    if (!this.fileLoggingEnabled) {
      // If file logging is disabled, just return
      return;
    }
    
    const logFile = path.join(this.logDir, this.getLogFileName());
    const timestamp = this.formatTimestamp(entry.timestamp);
    let logLine = `${timestamp} [${entry.eventType}]`;

    // Add request-specific information
    if (entry.requestId) {
      logLine += ` ${entry.requestId}`;
    }

    if (entry.method && entry.path) {
      logLine += ` ${entry.method} ${entry.path}`;
    }

    // Add event-specific details
    switch (entry.eventType) {
      case 'QUEUED':
        if (entry.priority !== undefined) {
          logLine += ` priority=${entry.priority}`;
        }
        break;

      case 'STARTED':
        if (entry.attempt && entry.maxAttempts) {
          logLine += ` attempt=${entry.attempt}/${entry.maxAttempts}`;
        }
        break;

      case 'COMPLETED':
        if (entry.status) {
          logLine += ` status=${entry.status}`;
        }
        if (entry.duration) {
          logLine += ` duration=${entry.duration}ms`;
        }
        if (entry.size) {
          logLine += ` size=${entry.size}`;
        }
        break;

      case 'FAILED':
        if (entry.status) {
          logLine += ` status=${entry.status}`;
        }
        if (entry.duration) {
          logLine += ` duration=${entry.duration}ms`;
        }
        if (entry.error) {
          logLine += ` error="${entry.error}"`;
        }
        break;

      case 'RETRY':
        if (entry.attempt && entry.maxAttempts) {
          logLine += ` attempt=${entry.attempt}/${entry.maxAttempts}`;
        }
        if (entry.delay) {
          logLine += ` delay=${entry.delay}ms`;
        }
        break;

      case 'CIRCUIT_OPEN':
        if (entry.threshold) {
          logLine += ` threshold=${entry.threshold}`;
        }
        if (entry.failures) {
          logLine += ` failures=${entry.failures}`;
        }
        if (entry.resetIn) {
          logLine += ` reset_in=${entry.resetIn}ms`;
        }
        break;

      case 'CIRCUIT_CLOSED':
        // No additional info needed
        break;
    }

    logLine += '\n';

    // Append to log file
    fs.appendFileSync(logFile, logLine);
  }

  public cleanOldLogs(retentionDays: number = 30): void {
    if (!this.fileLoggingEnabled) {
      // If file logging is disabled, don't try to clean logs
      return;
    }
    
    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    try {
      const files = fs.readdirSync(this.logDir);
      
      files.forEach(file => {
        if (file.endsWith('.log') && file.includes('_capfac_')) {
          const filePath = path.join(this.logDir, file);
          const stats = fs.statSync(filePath);
          
          if (now - stats.mtimeMs > retentionMs) {
            fs.unlinkSync(filePath);
            console.log(`Deleted old log file: ${file}`);
          }
        }
      });
    } catch (error) {
      console.error('Error cleaning old logs:', error);
    }
  }
}

// Singleton instance
let loggerInstance: RequestLogger | null = null;
let cleanupIntervalId: NodeJS.Timeout | null = null;

export function initializeRequestLogger(port: number): void {
  if (!loggerInstance) {
    loggerInstance = new RequestLogger(port);
    
    // Only set up cleanup if file logging is enabled
    if (loggerInstance.fileLoggingEnabled) {
      // Set up daily cleanup
      cleanupIntervalId = setInterval(() => {
        loggerInstance!.cleanOldLogs();
      }, 24 * 60 * 60 * 1000); // Run once per day
      
      // Run initial cleanup
      loggerInstance.cleanOldLogs();
    }
  }
}

export function getRequestLogger(): RequestLogger {
  if (!loggerInstance) {
    throw new Error('Request logger not initialized. Call initializeRequestLogger(port) first.');
  }
  return loggerInstance;
}

export function cleanupRequestLogger(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  loggerInstance = null;
}