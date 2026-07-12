import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { CapFacDataService } from "@/server/cap-fac-data-service";
import { initializeRequestLogger } from "@/server/request-logger";
import { getTodayAEST } from "@/shared/date-utils";

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

// Create cached versions for different revalidation periods
const getCachedCapacityFactorsCurrentYear = unstable_cache(
	async (year: number) => {
		console.log(`🔄 Cache miss - fetching data for current year ${year}`);
		const service = getService();
		return await service.getCapacityFactors(year);
	},
	["capacity-factors", "current-year"],
	{
		revalidate: 3600, // 1 hour
		tags: ["capacity-factors", "current-year"],
	},
);

const getCachedCapacityFactorsPreviousYears = unstable_cache(
	async (year: number) => {
		console.log(`🔄 Cache miss - fetching data for previous year ${year}`);
		const service = getService();
		return await service.getCapacityFactors(year);
	},
	["capacity-factors", "previous-years"],
	{
		revalidate: 604800, // 1 week
		tags: ["capacity-factors", "previous-years"],
	},
);

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

		console.log(`🌐 API: Fetching capacity factors for year ${year}`);

		// Use the appropriate cached version based on the year
		const currentYear = getTodayAEST().year;
		const data =
			year === currentYear
				? await getCachedCapacityFactorsCurrentYear(year)
				: await getCachedCapacityFactorsPreviousYears(year);

		console.log(`🌐 API: Returning data for year ${year}`);

		// Prepare response with cache headers
		const response = NextResponse.json(data);

		if (year === currentYear) {
			// Current year: cache for 1 hour
			response.headers.set(
				"Cache-Control",
				"public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
			);
		} else if (year < currentYear) {
			// Previous years: cache for 1 week
			response.headers.set(
				"Cache-Control",
				"public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000",
			);
		} else {
			// Future years: no cache
			response.headers.set("Cache-Control", "no-store");
		}

		response.headers.set("Vary", "Accept-Encoding");

		return response;
	} catch (error) {
		console.error("API Error:", error);
		
		// Check if this is an OpenElectricity API error
		const errorResponse: any = {
			error: error instanceof Error ? error.message : "Internal server error",
		};
		
		// If the error has response details from OpenElectricity, include them
		if (error && typeof error === 'object' && 'response' in error) {
			const apiError = error as any;
			if (apiError.response) {
				errorResponse.originalURL = apiError.response.url || apiError.config?.url;
				errorResponse.originalResponseCode = apiError.response.status;
				
				// If there's additional error data from the API response
				if (apiError.response.data) {
					errorResponse.originalError = apiError.response.data;
				}
			}
		}
		
		// Also check if error has a cause that might contain API details
		if (error instanceof Error && error.cause) {
			const cause = error.cause as any;
			if (cause.url) {
				errorResponse.originalURL = cause.url;
			}
			if (cause.status) {
				errorResponse.originalResponseCode = cause.status;
			}
		}
		
		// Check for request details added by OEClientQueued
		if (error && typeof error === 'object' && 'requestDetails' in error) {
			const details = (error as any).requestDetails;
			if (details.url && !errorResponse.originalURL) {
				errorResponse.originalURL = details.url;
			}
			errorResponse.requestDetails = details;
		}
		
		return NextResponse.json(errorResponse, { status: 500 });
	}
}
