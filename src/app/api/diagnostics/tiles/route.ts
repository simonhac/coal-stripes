import { NextResponse } from "next/server";
import {
  probeYears,
  earliestDataYear,
  currentDataYear,
  yearRange,
  PROBE_WARM_MAX_MS,
  PROBE_COLD_MIN_MS,
  type ProbeResult,
  type TileClassification,
} from "@/server/cache-warmer";
import { getAESTDateTimeString } from "@/shared/date-utils";

// On-demand diagnostic, never itself cached; can be slow if a year is cold.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Probing is deliberately more expensive than it looks: each year is fetched
// twice (once with the edge bypassed to read the Data Cache honestly, once
// plainly to read the edge), and a genuinely cold year pays the upstream fetch
// rather than hiding behind an edge HIT. That is the point — this endpoint is
// the only place that state is visible.
//
// Cap the probe fan-out. This endpoint only re-exercises the already-public,
// CDN-cached /api/capacity-factors route — it adds no attack surface a caller
// doesn't already have — so it is left PUBLIC, which also lets the /diagnostics
// page read it without a secret in the browser. The cap is a belt-and-braces
// guard against an absurdly wide range.
const MAX_YEARS = 30;

// Warm/cold/uncertain describe the origin's Data Cache — the layer the cron
// warmer is responsible for. `edgeHits` is the separate, visitor-facing signal:
// how many years the CDN edge in this region could answer on its own. A year
// can be warm in one and not the other, and conflating them is what used to
// make a hollow cache read as healthy.
interface DiagnosticsSummary {
  yearsProbed: number;
  warm: number;
  cold: number;
  uncertain: number;
  failed: number; // count of !ok responses (also counted in `uncertain`)
  edgeHits: number;
  slowestYear: number | null;
  slowestMs: number | null;
  totalMs: number;
  allWarm: boolean; // the one-line "is cron caching working?" verdict
}

interface TilesDiagnosticsResponse {
  generatedAt: string; // AEST, +10:00
  range: { from: number; to: number };
  thresholds: { warmMaxMs: number; coldMinMs: number };
  summary: DiagnosticsSummary;
  tiles: ProbeResult[];
}

/** Resolve the year range from `?year=` / `?years=FROM-TO`, or the full span. */
function resolveRange(
  searchParams: URLSearchParams,
): { from: number; to: number } | { error: string } {
  const single = searchParams.get("year");
  const range = searchParams.get("years");

  let from: number;
  let to: number;

  if (single !== null) {
    from = to = Number.parseInt(single, 10);
  } else if (range !== null) {
    const match = /^(\d{4})-(\d{4})$/.exec(range.trim());
    if (!match) {
      return { error: "Invalid years parameter (expected FROM-TO, e.g. 2006-2026)" };
    }
    from = Number.parseInt(match[1], 10);
    to = Number.parseInt(match[2], 10);
  } else {
    from = earliestDataYear();
    to = currentDataYear();
  }

  if (Number.isNaN(from) || Number.isNaN(to)) {
    return { error: "Invalid year parameter" };
  }
  if (from < 1900 || to > 2100 || from > to) {
    return { error: "Year range out of bounds (1900-2100, FROM <= TO)" };
  }
  if (to - from + 1 > MAX_YEARS) {
    return { error: `Year range too wide (max ${MAX_YEARS} years)` };
  }

  return { from, to };
}

function summarise(tiles: ProbeResult[]): DiagnosticsSummary {
  const countBy = (c: TileClassification) =>
    tiles.filter((t) => t.classification === c).length;

  const slowest = tiles.reduce<ProbeResult | null>(
    (max, t) => (max === null || t.ms > max.ms ? t : max),
    null,
  );

  const cold = countBy("cold");
  const uncertain = countBy("uncertain");

  return {
    yearsProbed: tiles.length,
    warm: countBy("warm"),
    cold,
    uncertain,
    failed: tiles.filter((t) => !t.ok).length,
    edgeHits: tiles.filter(
      (t) => t.edge.xVercelCache?.toUpperCase() === "HIT" || (t.edge.age ?? 0) > 0,
    ).length,
    slowestYear: slowest?.year ?? null,
    slowestMs: slowest?.ms ?? null,
    totalMs: tiles.reduce((sum, t) => sum + t.ms, 0),
    allWarm: cold === 0 && uncertain === 0,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const range = resolveRange(searchParams);
  if ("error" in range) {
    return NextResponse.json({ error: range.error }, { status: 400 });
  }

  const tiles = await probeYears(yearRange(range.from, range.to));

  const body: TilesDiagnosticsResponse = {
    generatedAt: getAESTDateTimeString(),
    range,
    thresholds: { warmMaxMs: PROBE_WARM_MAX_MS, coldMinMs: PROBE_COLD_MIN_MS },
    summary: summarise(tiles),
    tiles,
  };

  const response = NextResponse.json(body);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
