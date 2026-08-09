import { createFileRoute } from '@tanstack/react-router';
import { capacityFactorHeaders } from '@/server/cache-headers';
import { NO_STORE } from '@/server/cache-headers';
import { envFlag } from '@/server/runtime-env';
import { buildYear, getYear } from '@/server/year-store';
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
 * Two layers sit under this handler. Workers Cache is in front of it, so it only
 * runs on a miss, and concurrent misses for the same year are collapsed into one
 * invocation whose response is streamed to every waiter. Under it is R2, which
 * holds every year and never expires — so a miss costs an R2 read, not the 3-9s
 * OpenElectricity fetch it used to. Reaching upstream from here is now the
 * exceptional path: a year nobody has built yet, or a brand-new bucket.
 *
 * `x-cf-source` says which of the two answered, because "did a visitor pay for
 * OpenElectricity?" is the question this whole design exists to answer, and it
 * should be readable from a single curl rather than inferred.
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

          const currentYear = getTodayAEST().year;

          // The stored object streams straight through: 180 KB of JSON never
          // gets parsed, and `builtAt` rides in metadata where the header can
          // reach it without touching the body.
          const stored = await getYear(year);
          if (stored) {
            debug(`🌐 API: Serving year ${year} from R2`);
            const headers = capacityFactorHeaders(
              year,
              currentYear,
              stored.customMetadata?.builtAt ?? '',
              stored.customMetadata?.dataChangedAt,
            );
            headers.set('x-cf-source', 'r2');
            headers.set('Content-Type', 'application/json');
            return new Response(stored.body, { headers });
          }

          // Miss: build it, store it for everyone after this visitor, serve it.
          // The put is awaited rather than deferred — it is a few milliseconds
          // against the seconds we just spent upstream, and letting the response
          // race the write is how a year ends up permanently unstored.
          debug(`🌐 API: Building year ${year} from OpenElectricity`);
          const { dto, dataChangedAt } = await buildYear(year);

          const headers = capacityFactorHeaders(
            year,
            currentYear,
            dto.created_at,
            dataChangedAt,
          );
          headers.set('x-cf-source', 'upstream');
          return Response.json(dto, { headers });
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
