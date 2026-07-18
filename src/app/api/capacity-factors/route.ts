import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { CapFacDataService } from "@/server/cap-fac-data-service";
import { initializeRequestLogger } from "@/server/request-logger";
import { getTodayAEST, getAESTDateTimeString } from "@/shared/date-utils";
import {
	yearCachePolicy,
	YEAR_CACHE_TIERS,
	type YearCacheTier,
} from "@/shared/config";

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

// Create a singleton instance of the service to avoid creating multiple API clients
let serviceInstance: CapFacDataService | null = null;

function getService(): CapFacDataService {
	if (!serviceInstance) {
		const apiKey = process.env.OPENELECTRICITY_API_KEY;
		if (!apiKey) {
			throw new Error("API key not configured");
		}
		serviceInstance = new CapFacDataService(apiKey);
	}
	return serviceInstance;
}

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
const coldFetches = new Map<number, ColdFetchRecord>();

async function fetchCapacityFactors(year: number) {
	debug(`🔄 Cache miss - fetching data for year ${year}`);
	const service = getService();
	const started = performance.now();
	const result = await service.getCapacityFactors(year);
	const prev = coldFetches.get(year);
	coldFetches.set(year, {
		lastColdFetchAt: getAESTDateTimeString(),
		lastColdFetchMs: Math.round(performance.now() - started),
		count: (prev?.count ?? 0) + 1,
	});
	return result;
}

// One unstable_cache wrapper per freshness tier (revalidate is static per
// wrapper, so the tiers can't share one). Freshness windows live in
// yearCachePolicy — see @/shared/config. A year crossing a tier boundary
// (current→recent at New Year, recent→archive at N-6) changes wrapper and
// hence Data Cache key, costing one cache miss that the next cron warmer run
// absorbs.
//
// Tags are kept so a tier can be busted on demand via revalidateTag() if we
// ever need instant propagation.
const tierCaches = Object.fromEntries(
	(Object.keys(YEAR_CACHE_TIERS) as YearCacheTier[]).map((tier) => [
		tier,
		unstable_cache(fetchCapacityFactors, ["capacity-factors", tier], {
			revalidate: YEAR_CACHE_TIERS[tier].revalidateSeconds,
			tags: ["capacity-factors", tier],
		}),
	]),
) as Record<YearCacheTier, typeof fetchCapacityFactors>;

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

		debug(`🌐 API: Fetching capacity factors for year ${year}`);

		// Pick the freshness tier for this year. NEM data is subject to revision
		// (January can revise the December just past), so no tier is immutable.
		const currentYear = getTodayAEST().year;
		const policy = yearCachePolicy(year, currentYear);

		// Detect whether THIS request triggered a cold fetch, by watching the
		// cold-fetch counter across the (possibly cached) await.
		const coldBefore = coldFetches.get(year)?.count ?? 0;
		const data = await tierCaches[policy.tier](year);
		const coldAfter = coldFetches.get(year);
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

		if (year > currentYear) {
			// Future years: never cache (data does not exist yet).
			response.headers.set("Cache-Control", "no-store");
		} else {
			response.headers.set(
				"Cache-Control",
				`public, max-age=${policy.revalidateSeconds}, s-maxage=${policy.revalidateSeconds}, stale-while-revalidate=${policy.swrSeconds}`,
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
