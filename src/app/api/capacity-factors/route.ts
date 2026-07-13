import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { CapFacDataService } from "@/server/cap-fac-data-service";
import { initializeRequestLogger } from "@/server/request-logger";
import { getTodayAEST } from "@/shared/date-utils";
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

async function fetchCapacityFactors(year: number) {
	debug(`🔄 Cache miss - fetching data for year ${year}`);
	const service = getService();
	return await service.getCapacityFactors(year);
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
		const data = await tierCaches[policy.tier](year);

		debug(`🌐 API: Returning data for year ${year}`);

		// Prepare response with cache headers
		const response = NextResponse.json(data);

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
