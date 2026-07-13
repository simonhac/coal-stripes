import { OpenElectricityClient } from 'openelectricity';
import type {
  NetworkCode,
  DataMetric,
  IFacilityTimeSeriesParams,
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
 * Wrapper around the official OpenElectricity SDK client that adds request
 * queuing, rate limiting, retry with backoff, and a circuit breaker (all
 * provided by RequestQueue — see @/shared/request-queue).
 *
 * The SDK (`openelectricity` on npm) talks to https://api.openelectricity.org.au
 * and needs only an API key. This wrapper exists because the app fans out one
 * request per network (NEM, WEM) per year of data, and a burst of those must
 * not trip the API's rate limits — the queue spaces and retries them.
 */
export class OEClientQueued {
  private client: OpenElectricityClient;
  // One queue shared by both endpoints, so their requests are rate-limited
  // together; each method casts add()'s result back to its execute() type.
  private requestQueue: RequestQueue<FacilityResponse | ITimeSeriesResponse>;

  constructor(apiKey: string) {
    this.client = new OpenElectricityClient({ apiKey });
    this.requestQueue = new RequestQueue(
      SERVER_REQUEST_QUEUE_CONFIG,
      new FileRequestQueueLogger()
    );
  }

  /**
   * Fetch facility/unit metadata from the OpenElectricity `/facilities`
   * endpoint. `params` filters the result — this app passes
   * `status_id: ['operating']` and `fueltech_id: ['coal_black', 'coal_brown']`
   * to get just the operating coal units (see CapFacDataService).
   *
   * The response's `table.getRecords()` yields one record per generating unit,
   * each carrying its facility's code/name/network/region alongside the unit's
   * code, fueltech and registered capacity.
   */
  async getFacilities(params: IFacilityParams): Promise<FacilityResponse> {
    const url = '/facilities';
    return this.requestQueue.add({
      execute: () => this.client.getFacilities(params),
      priority: 1, // Medium priority
      method: 'GET',
      url,
      onError: (error) => attachRequestDetails(error, { url, method: 'GET' }),
    }) as Promise<FacilityResponse>;
  }

  /**
   * Fetch time-series data for a set of facilities from the OpenElectricity
   * `/data/facilities/{network}` endpoint. This app requests the `energy`
   * metric at a `1d` interval for every coal facility in a network, one
   * calendar year at a time (`dateEnd` is exclusive — see CapFacDataService).
   *
   * The returned `ITimeSeriesResponse.datatable` has one row per unit per
   * interval; a null metric value means "no data", which is distinct from 0.
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
    }) as Promise<ITimeSeriesResponse>;
  }

  /**
   * Clear all pending requests
   */
  clearQueue() {
    this.requestQueue.clear();
  }
}
