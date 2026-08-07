import { createFileRoute } from '@tanstack/react-router';
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { capacityFactorHeaders } from '@/server/cache-headers';
import { NO_STORE } from '@/server/cache-headers';
import { envFlag } from '@/server/runtime-env';
import { getTodayAEST } from '@/shared/date-utils';

// Opt-in verbose logging: set DEBUG_OE=1 to trace requests locally.
const debug = (...args: unknown[]): void => {
  if (envFlag('DEBUG_OE')) console.log(...args);
};

// The error payload we return, enriched with OpenElectricity details when present.
interface ApiErrorResponse {
  error: string;
  originalURL?: string;
  originalResponseCode?: number;
  originalError?: unknown;
  requestDetails?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Unpick the several shapes an OpenElectricity failure can arrive in. */
function describeError(error: unknown): ApiErrorResponse {
  const out: ApiErrorResponse = {
    error: error instanceof Error ? error.message : 'Internal server error',
  };

  // If the error carries an OpenElectricity response, include its details.
  if (isRecord(error) && isRecord(error.response)) {
    const response = error.response;
    const config = isRecord(error.config) ? error.config : undefined;
    out.originalURL = (response.url as string) ?? (config?.url as string | undefined);
    out.originalResponseCode = response.status as number | undefined;
    if (response.data !== undefined) out.originalError = response.data;
  }

  // A thrown Error may also carry API details on its `cause`.
  if (error instanceof Error && isRecord(error.cause)) {
    if (error.cause.url) out.originalURL = error.cause.url as string;
    if (error.cause.status) out.originalResponseCode = error.cause.status as number;
  }

  // Request details attached by OEClientQueued.
  if (isRecord(error) && isRecord(error.requestDetails)) {
    const details = error.requestDetails;
    if (details.url && !out.originalURL) out.originalURL = details.url as string;
    out.requestDetails = details;
  }

  return out;
}

/**
 * One year of per-unit capacity factors.
 *
 * Compare this with the Next version it replaces: there is no cache wrapper, no
 * single-flight map and no cold-fetch bookkeeping, because Workers Cache sits in
 * front of this handler. It only runs on a miss, and concurrent misses for the
 * same year are collapsed into one invocation whose response is streamed to
 * every waiter — which is exactly what `inFlight` in cf-cache.ts was hand-rolling.
 * Freshness and invalidation are entirely in the response headers; see
 * @/server/cache-headers.
 */
export const Route = createFileRoute('/api/capacity-factors')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { searchParams } = new URL(request.url);
          const yearParam = searchParams.get('year');

          if (!yearParam) {
            return Response.json(
              { error: 'Year parameter is required' },
              { status: 400, headers: NO_STORE },
            );
          }

          const year = Number.parseInt(yearParam);
          if (Number.isNaN(year) || year < 1900 || year > 2100) {
            return Response.json(
              { error: 'Invalid year parameter' },
              { status: 400, headers: NO_STORE },
            );
          }

          // There is no `fleet` parameter: one roster is served (every unit that
          // ever operated, each tagged with `status`), and the `current` view is
          // a client-side filter over it — see @/shared/fleet-filter. A stale
          // `?fleet=` is ignored rather than rejected, so an old bookmark still
          // gets a valid payload — but note it forks the cache entry, since the
          // key includes the whole query string.

          debug(`🌐 API: Fetching capacity factors for year ${year}`);

          const data = await getCapFacDataService().getCapacityFactors(year);

          debug(`🌐 API: Returning data for year ${year}`);

          return Response.json(data, {
            headers: capacityFactorHeaders(year, getTodayAEST().year, data.created_at),
          });
        } catch (error) {
          console.error('API Error:', error);
          return Response.json(describeError(error), {
            status: 500,
            headers: NO_STORE,
          });
        }
      },
    },
  },
});
