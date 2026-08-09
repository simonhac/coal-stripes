import { OpenElectricityClient, NoDataFound } from 'openelectricity';
import type {
  NetworkCode,
  DataMetric,
  IFacilityTimeSeriesParams,
  ITimeSeriesResponse,
} from 'openelectricity';
import PQueue from 'p-queue';
import pRetry from 'p-retry';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRequestLogger } from './request-logger';

// Types the package declares but does not re-export from its root — derive them
// structurally from the client so they stay in sync with the installed version.
type FacilityResponse = Awaited<ReturnType<OpenElectricityClient['getFacilities']>>;
type IFacilityParams = NonNullable<Parameters<OpenElectricityClient['getFacilities']>[0]>;

// OpenElectricity rate-limit protection: at most 10 requests in flight, no two
// request starts within 100ms of each other.
//
// Measured against the live API, nothing pushes back on us — bursts of 4, 8 and
// 12 concurrent full-year queries all returned zero 429s. But their cold
// throughput saturates around one heavy request per second, so going wider than
// ~8 in flight only inflates everyone's latency for no extra throughput. These
// numbers are therefore a ceiling, not a target; the useful lever is how many
// years a caller asks for at once (see REFRESH_CONCURRENCY in
// @/server/store-refresher).
const QUEUE_OPTIONS = { concurrency: 10, interval: 100, intervalCap: 1 } as const;

/**
 * The queue is scoped to one fan-out, NOT to the isolate.
 *
 * On Vercel this was a single module-level PQueue, one rate limiter shared by
 * every request the instance served. That cannot work on workerd, for two
 * compounding reasons:
 *
 *   1. Timers only advance while the request that created them is alive. The
 *      `interval`/`intervalCap` pacing is driven by `setTimeout`, so a queue
 *      created during request A simply stops ticking once A finishes — and the
 *      next request waits on it forever. Observed directly: "your Worker's code
 *      had hung and would never generate a response".
 *   2. workerd cancels promise continuations that resolve in a different
 *      request context than the one that created them, which takes out the
 *      queue's internal concurrency gating the same way.
 *
 * Neither is caught by testing p-queue inside a single request, which is why
 * the spike passed and this only appeared under real page load.
 *
 * So: one queue per `withRequestQueue` scope, created inside the request that
 * uses it. Pacing is preserved where it matters — across the several OE calls a
 * single year's build fans out into. What is lost is pacing *between*
 * concurrent requests; that is now bounded instead by Workers Cache collapsing
 * duplicate misses and by the store refresher's own concurrency limit.
 */
const queueStore = new AsyncLocalStorage<PQueue>();

/**
 * Run `fn` with a fresh queue shared by every OpenElectricity request it makes.
 * Wrap each unit of work that fans out — see CapFacDataService.
 */
export function withRequestQueue<T>(fn: () => Promise<T>): Promise<T> {
  return queueStore.run(new PQueue(QUEUE_OPTIONS), fn);
}

/**
 * There is deliberately no priority mechanism here any more.
 *
 * A `withQueuePriority` / `QUEUE_PRIORITY` pair used to exist so the cron could
 * queue its sweep below a visitor's cold fetch. It had no call sites, and could
 * not have helped if it had: `withRequestQueue` scopes a queue to a single
 * fan-out, so the refresher and a visitor never share one and there is nothing
 * for a priority to order them against.
 */
// 2 retries with exponential backoff: 1s then 2s (~3s of added latency, capped
// at 4s). Kept deliberately short so a genuinely cold miss returns in a few
// seconds rather than ~15s; a warm-all cron re-attempts any year that fails
// under transient upstream rate-limiting, so we don't need long retry chains.
const RETRY_OPTIONS = { retries: 2, minTimeout: 1_000, maxTimeout: 4_000 } as const;

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
 * queuing with rate limiting (p-queue) and retry with exponential backoff
 * (p-retry).
 *
 * The SDK (`openelectricity` on npm) talks to https://api.openelectricity.org.au
 * and needs only an API key. This wrapper exists because the app fans out one
 * request per network (NEM, WEM) per year of data, and a burst of those must
 * not trip the API's rate limits — the queue spaces and retries them.
 */
export class OEClientQueued {
  private client: OpenElectricityClient;

  /**
   * The queue for the current fan-out. One queue shared by both endpoints, so
   * their requests are rate-limited together — but scoped to the request rather
   * than the isolate (see queueStore above).
   *
   * Outside a `withRequestQueue` scope each call gets its own queue: correct,
   * just unpaced relative to its siblings. That path is only taken by callers
   * that make a single OE request anyway.
   */
  private get queue(): PQueue {
    return queueStore.getStore() ?? new PQueue(QUEUE_OPTIONS);
  }

  constructor(apiKey: string) {
    this.client = new OpenElectricityClient({ apiKey });
  }

  /**
   * Run a request through the queue with retries. Each retry attempt re-enters
   * the queue, so backoff waits don't hold a concurrency slot and retries are
   * rate-limited like any other request.
   */
  private run<T>(details: OERequestDetails, execute: () => Promise<T>): Promise<T> {
    const logger = getRequestLogger();
    const requestId = logger.getNextRequestId();
    const startTime = performance.now();

    return pRetry(() => this.queue.add(execute) as Promise<T>, {
      ...RETRY_OPTIONS,
      // A 404 → NoDataFound means the range genuinely has no data (e.g. WEM
      // before 2006, or a retired unit queried for a year it didn't run).
      // Retrying can't conjure data, so fail fast — callers tolerate it per
      // network (see CapFacDataService.fetchEnergyData).
      shouldRetry: ({ error }) => !(error instanceof NoDataFound),
      onFailedAttempt: ({ error, attemptNumber, retryDelay }) => {
        logger.log({
          timestamp: new Date(),
          eventType: 'RETRY',
          requestId,
          method: details.method,
          path: details.url,
          attempt: attemptNumber,
          maxAttempts: RETRY_OPTIONS.retries + 1,
          delay: retryDelay,
          error: error.message,
        });
      },
    }).then(
      (result) => {
        logger.log({
          timestamp: new Date(),
          eventType: 'COMPLETED',
          requestId,
          method: details.method,
          path: details.url,
          duration: Math.round(performance.now() - startTime),
        });
        return result;
      },
      (error: unknown) => {
        logger.log({
          timestamp: new Date(),
          eventType: 'FAILED',
          requestId,
          method: details.method,
          path: details.url,
          duration: Math.round(performance.now() - startTime),
          error: error instanceof Error ? error.message : String(error),
        });
        attachRequestDetails(error, details);
        throw error;
      }
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
    return this.run({ url: '/facilities', method: 'GET' }, () =>
      this.client.getFacilities(params)
    );
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

    return this.run({ url, method: 'GET', networkCode, facilityCodes: facilityList }, () =>
      this.client.getFacilityData(networkCode, facilityCodes, metrics, params)
    );
  }

  /**
   * Drop any queued (not yet started) requests in the current scope.
   *
   * A no-op outside a `withRequestQueue` scope: there is no isolate-wide queue
   * left to drain, and each unscoped call owns a queue nobody else can see.
   */
  clearQueue() {
    queueStore.getStore()?.clear();
  }
}
