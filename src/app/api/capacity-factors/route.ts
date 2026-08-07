import { NextResponse } from "next/server";
import {
	cachePolicyForYear,
	coldFetchCount,
	getCachedCapacityFactors,
	lastColdFetch,
} from "@/server/cf-cache";
import { initializeRequestLogger } from "@/server/request-logger";
import { getTodayAEST } from "@/shared/date-utils";
import type { FleetMode } from "@/shared/types";

// Opt-in verbose logging: set DEBUG_OE=1 to trace requests locally.
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

// This route is a thin HTTP wrapper. The Data Cache itself — the unstable_cache
// wrappers, the tier/mode key layout and the cold-fetch bookkeeping — lives in
// @/server/cf-cache, because the cron warmer calls the very same wrappers
// in-process and the two must share one set of instances to share cache keys.
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
		const policy = cachePolicyForYear(year);

		// Detect whether THIS request triggered a cold fetch, by watching the
		// cold-fetch counter across the (possibly cached) await.
		const coldBefore = coldFetchCount(year, mode);
		const data = await getCachedCapacityFactors(year, mode);
		const didColdFetch = coldFetchCount(year, mode) > coldBefore;

		debug(`🌐 API: Returning data for year ${year}`);

		// Prepare response with cache headers
		const response = NextResponse.json(data);

		// Diagnostics marker: did this request pay a cold OpenElectricity fetch?
		// Read back by probeYears() in @/server/cache-warmer.
		response.headers.set("x-cf-cold", String(didColdFetch));
		if (didColdFetch) {
			const record = lastColdFetch(year, mode);
			if (record) {
				response.headers.set("x-cf-cold-ms", String(record.lastColdFetchMs));
			}
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
