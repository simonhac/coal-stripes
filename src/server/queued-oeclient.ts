import { OpenElectricityClient } from 'openelectricity';
import type {
  NetworkCode,
  DataMetric,
  IFacilityTimeSeriesParams,
  INetworkTimeSeriesParams,
  ITimeSeriesResponse,
} from 'openelectricity';
import { RequestQueue } from '@/shared/request-queue';
import { SERVER_REQUEST_QUEUE_CONFIG } from '@/shared/config';
import { FileRequestQueueLogger } from './file-request-queue-logger';

// Types the package declares but does not re-export from its root — derive them
// structurally from the client so they stay in sync with the installed version.
type FacilityResponse = Awaited<ReturnType<OpenElectricityClient['getFacilities']>>;
type IFacilityParams = NonNullable<Parameters<OpenElectricityClient['getFacilities']>[0]>;

/** Details we attach to a thrown error so the API route can surface them. */
export interface OERequestDetails {
  url: string;
  method: string;
  networkCode?: NetworkCode;
  facilityCodes?: string[];
  metrics?: DataMetric[];
  params?: unknown;
}

/** Attach request context to an error without swallowing its type. */
function attachRequestDetails(error: unknown, details: OERequestDetails): void {
  if (error && typeof error === 'object') {
    (error as { requestDetails?: OERequestDetails }).requestDetails = details;
  }
}

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
  async getFacilities(params: IFacilityParams): Promise<FacilityResponse> {
    const url = '/facilities';
    return this.requestQueue.add({
      execute: () => this.client.getFacilities(params),
      priority: 1, // Medium priority
      method: 'GET',
      url,
      onError: (error) => attachRequestDetails(error, { url, method: 'GET' }),
    });
  }

  /**
   * Get facility data with queuing and rate limiting
   */
  async getFacilityData(
    networkCode: NetworkCode,
    facilityCodes: string | string[],
    metrics: DataMetric[],
    params: IFacilityTimeSeriesParams
  ): Promise<ITimeSeriesResponse> {
    const facilityList = Array.isArray(facilityCodes) ? facilityCodes : [facilityCodes];

    // Build a readable URL for logging, truncating long facility lists.
    const queryParams = new URLSearchParams();
    if (facilityList.length > 3) {
      queryParams.append(
        'facilities',
        `${facilityList.slice(0, 2).join(',')}[...and ${facilityList.length - 2} others]`
      );
    } else {
      queryParams.append('facilities', facilityList.join(','));
    }
    if (metrics.length > 0) {
      queryParams.append('metrics', metrics.join(','));
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    }

    const url = `/data/facilities/${networkCode}?${queryParams.toString()}`;

    return this.requestQueue.add({
      execute: () => this.client.getFacilityData(networkCode, facilityCodes, metrics, params),
      priority: 0, // High priority for data requests
      method: 'GET',
      url,
      onError: (error) =>
        attachRequestDetails(error, { url, method: 'GET', networkCode, facilityCodes: facilityList }),
    });
  }

  /**
   * Get network data with queuing and rate limiting
   */
  async getNetworkData(
    networkCode: NetworkCode,
    metrics: DataMetric[],
    params: INetworkTimeSeriesParams
  ): Promise<ITimeSeriesResponse> {
    const url = `/data/network/${networkCode}`;
    return this.requestQueue.add({
      execute: () => this.client.getNetworkData(networkCode, metrics, params),
      priority: 0, // High priority for data requests
      method: 'GET',
      url,
      onError: (error) =>
        attachRequestDetails(error, { url, method: 'GET', networkCode, metrics, params }),
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
