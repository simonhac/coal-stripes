import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getCapFacDataService } from "@/server/cap-fac-data-service";
import { initializeRequestLogger } from "@/server/request-logger";
import { getTodayAEST, getAESTDateTimeString } from "@/shared/date-utils";
import {
	yearCachePolicy,
	YEAR_CACHE_TIERS,
	type YearCacheTier,
} from "@/shared/config";
import type { FleetMode } from "@/shared/types";

// Opt-in verbose logging: set DEBUG_OE=1 to trace requests/cache misses locally.
const debug = (...args: unknown[]): void => {
	if (process.env.DEBUG_OE) console.log(...args);
};

// The error payload we return, enriched with OpenElectricity details when present.
interface ApiErrorResponse {
	error: string;
	originalURL?: string;
	originalResponseCode?: number;
	originalError?: unknown;
	requestDetails?: unknown;
}

// Force dynamic mode to ensure our cache headers are respected
export const dynamic = "force-dynamic";

// Initialize logger for API routes
const port = Number.parseInt(process.env.PORT || "3000");
initializeRequestLogger(port);

// Per-instance record of genuine cold fetches. `fetchCapacityFactors` (below)
// is the function wrapped by unstable_cache, so it ONLY runs on a Data-Cache
// miss — i.e. a real, rate-limited OpenElectricity fetch. We record each such
// miss so GET can emit an `x-cf-cold` header telling the diagnostics probe
// whether THIS request paid a cold fetch. Module-level ⇒ per-serverless-instance
// and ephemeral: the per-request header (which travels on the same response) is
// authoritative; the historical fields are best-effort.
interface ColdFetchRecord {
	lastColdFetchAt: string;
	lastColdFetchMs: number;
	count: number;
}
const coldFetches = new Map<string, ColdFetchRecord>();

// Diagnostics key: cold fetches are tracked per (mode, year) since the two
// fleet modes are cached separately.
const coldKey = (year: number, mode: FleetMode): string => `${mode}:${year}`;

async function fetchCapacityFactors(year: number, mode: FleetMode) {
	debug(`🔄 Cache miss - fetching data for year ${year} (${mode})`);
	const service = getCapFacDataService();
	const started = performance.now();
	const result = await service.getCapacityFactors(year, mode);
	const key = coldKey(year, mode);
	const prev = coldFetches.get(key);
	coldFetches.set(key, {
		lastColdFetchAt: getAESTDateTimeString(),
		lastColdFetchMs: Math.round(performance.now() - started),
		count: (prev?.count ?? 0) + 1,
	});
	return result;
}

const FLEET_MODES: FleetMode[] = ["full", "current"];

// Bump to invalidate every cached CF tile in one deploy-atomic step (it changes
// the unstable_cache key, so all tiers/modes/years recompute on the fixed code
// with fresh facilities metadata). Bumped for the retired-unit colouring fix:
// future days are now null (not 0) for retired units, so tiles frozen under the
// old logic must be discarded rather than served stale.
const CF_CACHE_VERSION = "v2";

// One unstable_cache wrapper per (freshness tier, fleet mode). Revalidate is
// static per wrapper, so the tiers can't share one; and the mode is baked into
// the cache key parts so the two rosters (full vs current) never share a Data
// Cache entry. Freshness windows live in yearCachePolicy — see @/shared/config.
// A year crossing a tier boundary (current→recent at New Year, recent→archive
// at N-6) changes wrapper and hence Data Cache key, costing one cache miss that
// the next cron warmer run absorbs.
//
// Tags are kept so a tier/mode can be busted on demand via revalidateTag() if
// we ever need instant propagation.
const tierCaches = Object.fromEntries(
	(Object.keys(YEAR_CACHE_TIERS) as YearCacheTier[]).map((tier) => [
		tier,
		Object.fromEntries(
			FLEET_MODES.map((mode) => [
				mode,
				unstable_cache(
					fetchCapacityFactors,
					["capacity-factors", CF_CACHE_VERSION, tier, mode],
					{
						revalidate: YEAR_CACHE_TIERS[tier].revalidateSeconds,
						tags: ["capacity-factors", tier, mode],
					},
				),
			]),
		) as Record<FleetMode, typeof fetchCapacityFactors>,
	]),
) as Record<YearCacheTier, Record<FleetMode, typeof fetchCapacityFactors>>;

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url);
		const yearParam = searchParams.get("year");

		if (!yearParam) {
			return NextResponse.json(
				{ error: "Year parameter is required" },
				{ status: 400 },
			);
		}

		// sanity check year
		const year = Number.parseInt(yearParam);
		if (Number.isNaN(year) || year < 1900 || year > 2100) {
			return NextResponse.json(
				{ error: "Invalid year parameter" },
				{ status: 400 },
			);
		}

		// Fleet mode selects the roster: `full` (every unit that ever operated,
		// including retired plants) or `current` (operating units only).
		// Defaults to `full`.
		const fleetParam = searchParams.get("fleet");
		if (fleetParam !== null && fleetParam !== "full" && fleetParam !== "current") {
			return NextResponse.json(
				{ error: "Invalid fleet parameter (expected 'full' or 'current')" },
				{ status: 400 },
			);
		}
		const mode: FleetMode = fleetParam === "current" ? "current" : "full";

		debug(`🌐 API: Fetching capacity factors for year ${year} (${mode})`);

		// Pick the freshness tier for this year. NEM data is subject to revision
		// (January can revise the December just past), so no tier is immutable.
		const currentYear = getTodayAEST().year;
		const policy = yearCachePolicy(year, currentYear);

		// Detect whether THIS request triggered a cold fetch, by watching the
		// cold-fetch counter across the (possibly cached) await.
		const cKey = coldKey(year, mode);
		const coldBefore = coldFetches.get(cKey)?.count ?? 0;
		const data = await tierCaches[policy.tier][mode](year, mode);
		const coldAfter = coldFetches.get(cKey);
		const didColdFetch = (coldAfter?.count ?? 0) > coldBefore;

		debug(`🌐 API: Returning data for year ${year}`);

		// Prepare response with cache headers
		const response = NextResponse.json(data);

		// Diagnostics marker: did this request pay a cold OpenElectricity fetch?
		// Read back by probeYears() in @/server/cache-warmer.
		response.headers.set("x-cf-cold", String(didColdFetch));
		if (didColdFetch && coldAfter) {
			response.headers.set("x-cf-cold-ms", String(coldAfter.lastColdFetchMs));
		}

		// When this payload was actually assembled from OpenElectricity — NOT when
		// it was read from a cache. It travels with the body, so a copy replayed
		// from the CDN still reports its true age. Surfaced per year on
		// /diagnostics; the same value reaches /stats via the DTO's created_at.
		response.headers.set("x-cf-built-at", data.created_at);

		// Vercel CDN cache tags, so the purge endpoint can invalidate the edge —
		// something revalidateTag cannot do for a route that sets its own
		// Cache-Control. Note the year is tag-able here even though the Data Cache
		// tags can't be: those are fixed per (tier, mode) wrapper, whereas this
		// header is written per response.
		response.headers.set(
			"Vercel-Cache-Tag",
			`capacity-factors,cf-${policy.tier},cf-${mode},cf-year-${year}`,
		);

		if (year > currentYear) {
			// Future years: never cache (data does not exist yet).
			response.headers.set("Cache-Control", "no-store");
		} else {
			// Split browser and edge lifetimes. The browser cache is the ONE layer
			// no purge can reach, so keep it short — a fix must never be masked by
			// a copy sitting in someone's browser. The Vercel edge keeps the full
			// freshness-tier window (it's fast, and now purgeable by tag), and
			// TanStack Query already dedupes within a session, so the short browser
			// max-age costs at most one edge round-trip per year per page load.
			response.headers.set("Cache-Control", "public, max-age=60");
			response.headers.set(
				"Vercel-CDN-Cache-Control",
				`public, s-maxage=${policy.revalidateSeconds}, stale-while-revalidate=${policy.swrSeconds}`,
			);
		}

		response.headers.set("Vary", "Accept-Encoding");

		return response;
	} catch (error) {
		console.error("API Error:", error);

		const errorResponse: ApiErrorResponse = {
			error: error instanceof Error ? error.message : "Internal server error",
		};

		const isRecord = (v: unknown): v is Record<string, unknown> =>
			typeof v === "object" && v !== null;

		// If the error carries an OpenElectricity response, include its details.
		if (isRecord(error) && isRecord(error.response)) {
			const response = error.response;
			const config = isRecord(error.config) ? error.config : undefined;
			errorResponse.originalURL =
				(response.url as string) ?? (config?.url as string | undefined);
			errorResponse.originalResponseCode = response.status as number | undefined;
			if (response.data !== undefined) {
				errorResponse.originalError = response.data;
			}
		}

		// A thrown Error may also carry API details on its `cause`.
		if (error instanceof Error && isRecord(error.cause)) {
			if (error.cause.url) errorResponse.originalURL = error.cause.url as string;
			if (error.cause.status) {
				errorResponse.originalResponseCode = error.cause.status as number;
			}
		}

		// Request details attached by OEClientQueued.
		if (isRecord(error) && isRecord(error.requestDetails)) {
			const details = error.requestDetails;
			if (details.url && !errorResponse.originalURL) {
				errorResponse.originalURL = details.url as string;
			}
			errorResponse.requestDetails = details;
		}

		return NextResponse.json(errorResponse, { status: 500 });
	}
}
