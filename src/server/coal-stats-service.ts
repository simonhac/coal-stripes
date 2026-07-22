/**
 * Server-side computation of coal-generation statistics.
 *
 * The app's capacity-factor payloads carry, per unit, a registered capacity and
 * a daily capacity factor. Absolute generation is the exact inverse of the
 * server's CF derivation:
 *
 *     energy_MWh(unit, day) = capacityFactor/100 × capacity_MW × 24
 *
 * We sum that across every coal unit to get daily generation per region and
 * network, then roll it up into peak and most-recent figures at four
 * granularities (day / month / quarter / year). Missing days for units that
 * were alive are counted as holes and surfaced so no total is presented as
 * solid when it isn't (see @/shared/data-gaps and PeriodCoverage).
 *
 * Data is pulled by self-fetching the cached /api/capacity-factors route once
 * per year — reusing the warm Data Cache rather than re-hitting OpenElectricity
 * — exactly as the cache warmer does. The whole result is cached daily by the
 * /api/stats route.
 */

import { CalendarDate, parseDate } from '@internationalized/date';
import type {
  CoalGenerationStatsDTO,
  DataGap,
  FleetMode,
  GeneratingUnitCapFacHistoryDTO,
  GranularityStat,
  PeriodCoverage,
  StatRow,
  StatValue,
} from '@/shared/types';
import { DATE_BOUNDARIES } from '@/shared/config';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { getAESTDateTimeString, getDaysBetween, getQuarter } from '@/shared/date-utils';
import { formatPeriodLabel, type Granularity } from '@/shared/energy-format';
import { getBaseUrl, currentDataYear, earliestDataYear, yearRange } from '@/server/cache-warmer';

const STATS_VERSION = '1.0';

// The stats table's rows, in display order. TAS1 is omitted (no coal). 'NEM' is
// the aggregate of its regions; 'WEM' is both a region and its own network; and
// 'ALL' is every coal unit.
const ROW_META: Record<string, { kind: StatRow['kind']; long: string; short: string }> = {
  NSW1: { kind: 'region', long: 'New South Wales', short: 'NSW' },
  QLD1: { kind: 'region', long: 'Queensland', short: 'QLD' },
  SA1: { kind: 'region', long: 'South Australia', short: 'SA' },
  VIC1: { kind: 'region', long: 'Victoria', short: 'VIC' },
  NEM: { kind: 'network', long: 'National Electricity Market', short: 'NEM' },
  WEM: { kind: 'network', long: 'Western Australia (WEM)', short: 'WA' },
  ALL: { kind: 'total', long: 'All coal', short: 'All coal' },
};
const ROW_KEYS = Object.keys(ROW_META);
const NEM_REGION_ROWS = new Set(['NSW1', 'QLD1', 'SA1', 'VIC1']);

/** The row keys a unit contributes to, given its region and network. */
function rowsForUnit(region: string, network: string): string[] {
  if (network === 'wem') return ['WEM', 'ALL'];
  return NEM_REGION_ROWS.has(region) ? [region, 'NEM', 'ALL'] : ['NEM', 'ALL'];
}

interface UnitSeries {
  duid: string;
  region: string; // NEM region code, or 'WEM'
  network: string; // 'nem' | 'wem'
  cf: Float64Array; // capacity factor per global day index; NaN = no data
  cap: Float64Array; // registered capacity (MW) per global day index
}

// Per-row daily accumulators, indexed by global day index (days since EARLIEST).
interface RowAccum {
  mwh: Float64Array;
  expected: Float64Array; // alive unit-days
  present: Float64Array; // alive unit-days with data
  hole: Float64Array; // alive unit-days missing (interior gaps)
}

async function fetchYear(
  baseUrl: string,
  year: number,
  mode: FleetMode,
): Promise<GeneratingUnitCapFacHistoryDTO | null> {
  const res = await fetch(`${baseUrl}/api/capacity-factors?year=${year}&fleet=${mode}`, {
    headers: { 'user-agent': 'coal-stripes-stats' },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as GeneratingUnitCapFacHistoryDTO;
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function computeCoalStats(mode: FleetMode): Promise<CoalGenerationStatsDTO> {
  const baseUrl = getBaseUrl();
  const bounds = getDateBoundaries();
  const latestDataDay = bounds.latestDataDay;

  const EARLIEST = DATE_BOUNDARIES.EARLIEST_START_DATE;
  const firstYear = earliestDataYear();
  const lastYear = currentDataYear();
  const years = yearRange(firstYear, lastYear);

  // Global day index 0 = EARLIEST; the timeline runs to 31 Dec of the last year
  // (future days beyond latestDataDay simply carry no data).
  const timelineEnd = new CalendarDate(lastYear, 12, 31);
  const totalDays = getDaysBetween(EARLIEST, timelineEnd) + 1;
  const latestIdx = getDaysBetween(EARLIEST, latestDataDay);

  const idxToDate = (idx: number): CalendarDate => EARLIEST.add({ days: idx });

  // 1. Fetch every year (bounded concurrency; cached upstream) and assemble each
  //    unit's whole-of-history daily series.
  const dtos = await mapPool(years, 5, (y) => fetchYear(baseUrl, y, mode));

  const units = new Map<string, UnitSeries>();
  for (const dto of dtos) {
    if (!dto) continue;
    for (const u of dto.data) {
      const region = u.network === 'wem' ? 'WEM' : (u.region ?? 'UNKNOWN');
      let series = units.get(u.duid);
      if (!series) {
        series = {
          duid: u.duid,
          region,
          network: u.network,
          cf: new Float64Array(totalDays).fill(Number.NaN),
          cap: new Float64Array(totalDays),
        };
        units.set(u.duid, series);
      }
      const base = getDaysBetween(EARLIEST, parseDate(u.history.start));
      const arr = u.history.data;
      for (let i = 0; i < arr.length; i++) {
        const gi = base + i;
        if (gi < 0 || gi >= totalDays) continue;
        const v = arr[i];
        if (v !== null) series.cf[gi] = v;
        series.cap[gi] = u.capacity;
      }
    }
  }

  // 2. Accumulate per-row daily generation and coverage; collect data gaps.
  const rows: Record<string, RowAccum> = {};
  for (const key of ROW_KEYS) {
    rows[key] = {
      mwh: new Float64Array(totalDays),
      expected: new Float64Array(totalDays),
      present: new Float64Array(totalDays),
      hole: new Float64Array(totalDays),
    };
  }
  const gaps: DataGap[] = [];

  for (const series of units.values()) {
    // Global alive span: first and last day with data.
    let first = -1;
    let last = -1;
    for (let gi = 0; gi < totalDays; gi++) {
      if (!Number.isNaN(series.cf[gi])) {
        if (first < 0) first = gi;
        last = gi;
      }
    }
    if (first < 0) continue; // unit never reported any data

    const rowKeys = rowsForUnit(series.region, series.network);
    let gapStart = -1;

    for (let gi = first; gi <= last; gi++) {
      const cf = series.cf[gi];
      const isNull = Number.isNaN(cf);

      for (const rk of rowKeys) rows[rk].expected[gi] += 1;

      if (!isNull) {
        const m = (cf / 100) * series.cap[gi] * 24;
        for (const rk of rowKeys) {
          rows[rk].mwh[gi] += m;
          rows[rk].present[gi] += 1;
        }
        if (gapStart >= 0) {
          gaps.push(makeGap(series.region, series.duid, gapStart, gi - 1, idxToDate));
          gapStart = -1;
        }
      } else {
        for (const rk of rowKeys) rows[rk].hole[gi] += 1;
        if (gapStart < 0) gapStart = gi;
      }
    }
    // No trailing gap is possible: `last` is a data day by construction.
  }

  const totalHoleUnitDays = gaps.reduce((sum, g) => sum + g.days, 0);
  const sortedGaps = [...gaps].sort((a, b) => b.days - a.days);

  // 3. Precompute the "most recent complete period" start for each granularity.
  const recentStart: Record<Granularity, CalendarDate | null> = {
    day: latestDataDay,
    month: latestCompleteStart('month', latestDataDay),
    quarter: latestCompleteStart('quarter', latestDataDay),
    year: latestCompleteStart('year', latestDataDay),
  };

  // 4. Build each row's stats.
  const statRows: StatRow[] = [];
  for (const key of ROW_KEYS) {
    const accum = rows[key];
    // Skip empty region rows (a region with no coal ever). Network/total rows
    // always render.
    const hasData = sumRange(accum.present, 0, latestIdx) > 0;
    if (!hasData && ROW_META[key].kind === 'region') continue;

    statRows.push({
      key,
      kind: ROW_META[key].kind,
      label: { long: ROW_META[key].long, short: ROW_META[key].short },
      day: granularityStat('day', accum, latestIdx, recentStart.day, EARLIEST, latestDataDay, idxToDate),
      month: granularityStat('month', accum, latestIdx, recentStart.month, EARLIEST, latestDataDay, idxToDate),
      quarter: granularityStat('quarter', accum, latestIdx, recentStart.quarter, EARLIEST, latestDataDay, idxToDate),
      year: granularityStat('year', accum, latestIdx, recentStart.year, EARLIEST, latestDataDay, idxToDate),
    });
  }

  return {
    type: 'coal_generation_stats',
    version: STATS_VERSION,
    created_at: getAESTDateTimeString(),
    fleet: mode,
    latestDataDay: latestDataDay.toString(),
    units: 'MWh',
    rows: statRows,
    dataQuality: { totalHoleUnitDays, gaps: sortedGaps },
  };
}

// ---------------------------------------------------------------------------
// Period helpers
// ---------------------------------------------------------------------------

/** First calendar day of the period (of the given granularity) containing `d`. */
function periodStart(g: Granularity, d: CalendarDate): CalendarDate {
  switch (g) {
    case 'day':
      return d;
    case 'month':
      return new CalendarDate(d.year, d.month, 1);
    case 'quarter':
      return new CalendarDate(d.year, (getQuarter(d) - 1) * 3 + 1, 1);
    case 'year':
      return new CalendarDate(d.year, 1, 1);
  }
}

/** Last calendar day of the period starting at `start`. */
function periodEnd(g: Granularity, start: CalendarDate): CalendarDate {
  switch (g) {
    case 'day':
      return start;
    case 'month':
      return start.add({ months: 1 }).subtract({ days: 1 });
    case 'quarter':
      return start.add({ months: 3 }).subtract({ days: 1 });
    case 'year':
      return start.add({ years: 1 }).subtract({ days: 1 });
  }
}

/** Step back one period. */
function previousPeriodStart(g: Granularity, start: CalendarDate): CalendarDate {
  switch (g) {
    case 'day':
      return start.subtract({ days: 1 });
    case 'month':
      return start.subtract({ months: 1 });
    case 'quarter':
      return start.subtract({ months: 3 });
    case 'year':
      return start.subtract({ years: 1 });
  }
}

/**
 * Start of the latest COMPLETE period of granularity `g` — the most recent
 * period whose last calendar day has already elapsed (<= latestDataDay). The
 * partial current period is excluded.
 */
function latestCompleteStart(g: Granularity, latestDataDay: CalendarDate): CalendarDate | null {
  let start = periodStart(g, latestDataDay);
  if (periodEnd(g, start).compare(latestDataDay) > 0) {
    start = previousPeriodStart(g, start);
  }
  return start;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function sumRange(arr: Float64Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i <= to; i++) s += arr[i];
  return s;
}

function makeCoverage(expected: number, present: number, hole: number, total: number): PeriodCoverage {
  return {
    expectedUnitDays: expected,
    presentUnitDays: present,
    holeUnitDays: hole,
    coverage: expected > 0 ? present / expected : 1,
    estimatedFullTotal: hole > 0 && present > 0 ? (total * expected) / present : null,
  };
}

/** Aggregate a row's accumulators over the inclusive global-index range. */
function rangeStats(
  accum: RowAccum,
  from: number,
  to: number,
): { total: number; expected: number; present: number; hole: number } {
  return {
    total: sumRange(accum.mwh, from, to),
    expected: sumRange(accum.expected, from, to),
    present: sumRange(accum.present, from, to),
    hole: sumRange(accum.hole, from, to),
  };
}

function granularityStat(
  g: Granularity,
  accum: RowAccum,
  latestIdx: number,
  recentStart: CalendarDate | null,
  EARLIEST: CalendarDate,
  latestDataDay: CalendarDate,
  idxToDate: (idx: number) => CalendarDate,
): GranularityStat {
  const dateToIdx = (d: CalendarDate): number => getDaysBetween(EARLIEST, d);

  const peak = g === 'day' ? peakDay(accum, latestIdx, idxToDate) : peakPeriod(g, accum, latestIdx, idxToDate, latestDataDay);

  let recent: StatValue | null = null;
  if (recentStart) {
    const rStart = recentStart;
    const rEnd = periodEnd(g, rStart);
    const fromIdx = dateToIdx(rStart);
    const toIdx = Math.min(dateToIdx(rEnd), latestIdx);
    if (fromIdx >= 0 && toIdx >= fromIdx) {
      const r = rangeStats(accum, fromIdx, toIdx);
      if (r.present > 0) {
        recent = toStatValue(g, rStart, rEnd, r);
      }
    }
  }

  const proportion = peak && recent && peak.total > 0 ? recent.total / peak.total : null;
  return { peak, recent, proportion };
}

function toStatValue(
  g: Granularity,
  start: CalendarDate,
  end: CalendarDate,
  r: { total: number; expected: number; present: number; hole: number },
): StatValue {
  const days = getDaysBetween(start, end) + 1;
  return {
    total: r.total,
    avgPerDay: r.total / days,
    label: formatPeriodLabel(g, start),
    start: start.toString(),
    end: end.toString(),
    coverage: makeCoverage(r.expected, r.present, r.hole, r.total),
  };
}

function peakDay(
  accum: RowAccum,
  latestIdx: number,
  idxToDate: (idx: number) => CalendarDate,
): StatValue | null {
  let bestIdx = -1;
  let bestVal = -1;
  for (let gi = 0; gi <= latestIdx; gi++) {
    if (accum.present[gi] > 0 && accum.mwh[gi] > bestVal) {
      bestVal = accum.mwh[gi];
      bestIdx = gi;
    }
  }
  if (bestIdx < 0) return null;
  const d = idxToDate(bestIdx);
  return toStatValue('day', d, d, {
    total: accum.mwh[bestIdx],
    expected: accum.expected[bestIdx],
    present: accum.present[bestIdx],
    hole: accum.hole[bestIdx],
  });
}

interface Bucket {
  total: number;
  expected: number;
  present: number;
  hole: number;
}

function peakPeriod(
  g: Granularity,
  accum: RowAccum,
  latestIdx: number,
  idxToDate: (idx: number) => CalendarDate,
  latestDataDay: CalendarDate,
): StatValue | null {
  // Bucket days into calendar periods keyed by their start date.
  const buckets = new Map<string, { start: CalendarDate; b: Bucket }>();
  for (let gi = 0; gi <= latestIdx; gi++) {
    if (accum.expected[gi] === 0 && accum.mwh[gi] === 0) continue;
    const start = periodStart(g, idxToDate(gi));
    const key = start.toString();
    let entry = buckets.get(key);
    if (!entry) {
      entry = { start, b: { total: 0, expected: 0, present: 0, hole: 0 } };
      buckets.set(key, entry);
    }
    entry.b.total += accum.mwh[gi];
    entry.b.expected += accum.expected[gi];
    entry.b.present += accum.present[gi];
    entry.b.hole += accum.hole[gi];
  }

  let best: { start: CalendarDate; b: Bucket } | null = null;
  for (const entry of buckets.values()) {
    // Only complete periods (fully elapsed) with data compete for the peak.
    if (entry.b.present <= 0) continue;
    if (periodEnd(g, entry.start).compare(latestDataDay) > 0) continue;
    if (!best || entry.b.total > best.b.total) best = entry;
  }
  if (!best) return null;
  return toStatValue(g, best.start, periodEnd(g, best.start), best.b);
}

function makeGap(
  region: string,
  duid: string,
  fromIdx: number,
  toIdx: number,
  idxToDate: (idx: number) => CalendarDate,
): DataGap {
  return {
    duid,
    region,
    start: idxToDate(fromIdx).toString(),
    end: idxToDate(toIdx).toString(),
    days: toIdx - fromIdx + 1,
  };
}
