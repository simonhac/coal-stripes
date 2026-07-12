import { OpenElectricityClient } from 'openelectricity';
import { RequestQueue } from '@/shared/request-queue';
import { SERVER_REQUEST_QUEUE_CONFIG } from '@/shared/config';
import { FileRequestQueueLogger } from './file-request-queue-logger';

/**
 * Wrapper around OpenElectricityClient that adds request queuing,
 * rate limiting, and retry logic.
 */
export class OEClientQueued {
  private client: OpenElectricityClient;
  private requestQueue: RequestQueue;

  constructor(apiKey: string) {
    this.client = new OpenElectricityClient({ apiKey });
    this.requestQueue = new RequestQueue(
      SERVER_REQUEST_QUEUE_CONFIG,
      new FileRequestQueueLogger()
    );
  }

  /**
   * Get facilities with queuing and rate limiting
   */
  async getFacilities(params: any): Promise<any> {
    return this.requestQueue.add({
      execute: () => this.client.getFacilities(params),
      priority: 1, // Medium priority
      method: 'GET',
      url: '/facilities',
      onProgress: (progress) => {
        console.log(`Facilities request: ${progress}%`);
      },
      onError: (error) => {
        console.error('Facilities request failed:', error);
        // Enhance error with request details
        if (error && typeof error === 'object') {
          (error as any).requestDetails = {
            url: '/facilities',
            method: 'GET'
          };
        }
      }
    });
  }

  /**
   * Get facility data with queuing and rate limiting
   */
  async getFacilityData(
    networkCode: any,
    facilityCodes: string | string[],
    metrics: string[],
    params: any
  ): Promise<any> {
    const facilityList = Array.isArray(facilityCodes) ? facilityCodes : [facilityCodes];
    
    // Build complete URL with all query parameters
    const queryParams = new URLSearchParams();
    
    // Handle facilities parameter with truncation for logging
    if (facilityList.length > 3) {
      const truncated = `${facilityList.slice(0, 2).join(',')}[...and ${facilityList.length - 2} others]`;
      queryParams.append('facilities', truncated);
    } else {
      queryParams.append('facilities', facilityList.join(','));
    }
    
    if (metrics && metrics.length > 0) {
      queryParams.append('metrics', metrics.join(','));
    }
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
        }
      });
    }
    
    const url = `/data/facilities/${networkCode}?${queryParams.toString()}`;
    
    return this.requestQueue.add({
      execute: () => this.client.getFacilityData(networkCode, facilityCodes, metrics as any, params),
      priority: 0, // High priority for data requests
      method: 'GET',
      url,
      onProgress: (progress) => {
        console.log(`${networkCode} data request: ${progress}%`);
      },
      onError: (error) => {
        console.error(`${networkCode} data request failed:`, error);
        // Enhance error with request details
        if (error && typeof error === 'object') {
          (error as any).requestDetails = {
            url,
            method: 'GET',
            networkCode,
            facilityCodes: facilityList
          };
        }
      }
    });
  }

  /**
   * Get network data with queuing and rate limiting
   */
  async getNetworkData(
    networkCode: any,
    metrics: string[],
    params: any
  ): Promise<any> {
    return this.requestQueue.add({
      execute: () => this.client.getNetworkData(networkCode, metrics as any, params),
      priority: 0, // High priority for data requests
      method: 'GET',
      url: `/data/network/${networkCode}`,
      onProgress: (progress) => {
        console.log(`${networkCode} network data: ${progress}%`);
      },
      onError: (error) => {
        console.error(`${networkCode} network data failed:`, error);
        // Enhance error with request details
        if (error && typeof error === 'object') {
          (error as any).requestDetails = {
            url: `/network/${networkCode}/data`,
            method: 'GET',
            networkCode,
            metrics,
            params
          };
        }
      }
    });
  }

  /**
   * Get queue statistics
   */
  getQueueStats() {
    return this.requestQueue.getStats();
  }

  /**
   * Clear all pending requests
   */
  clearQueue() {
    this.requestQueue.clear();
  }
}