// Type definitions for capacity factor visualisation.
//
// The DTO types below define the JSON contract between our server route
// (/api/capacity-factors) and the client — the client never sees raw
// OpenElectricity responses, only this shape.

// Which roster of coal units the visualisation shows. `full` = every unit that
// ever operated across recorded history (includes retired plants); `current` =
// only units operating in the present year. The mode selects which rows exist;
// missing cells (e.g. a unit before it was commissioned, or WEM pre-2006) still
// render as the "no data" (null) pale blue. Threaded through the API query, the
// data-cache key, and the client query key.
export type FleetMode = 'full' | 'current';

/** A contiguous run of daily values for one unit. */
export interface UnitHistoryDTO {
  start: string; // first day, ISO date (inclusive)
  last: string; // last day, ISO date (inclusive)
  interval: string; // always '1d' — one value per day
  // Capacity factor per day, 0–100 (%). null = unknown (future dates, or a
  // gap in data collection); 0 = the unit ran but generated nothing. Never
  // conflate the two.
  data: (number | null)[];
}

/** One generating unit's metadata plus a year of capacity factors. */
export interface GeneratingUnitDTO {
  network: string; // 'nem' or 'wem'
  region?: string; // NEM region code (e.g. 'NSW1'); undefined for WEM units
  data_type: string;
  units: string;
  capacity: number; // registered capacity in MW
  // The unit's dispatchable unit identifier (DUID) — the market's unique code
  // for a generating unit, e.g. 'BW01' for Bayswater unit 1.
  duid: string;
  facility_code: string;
  facility_name: string;
  fueltech: string; // 'coal_black' or 'coal_brown'
  history: UnitHistoryDTO;
}

/** The full payload for one calendar year: every coal unit's history. */
export interface GeneratingUnitCapFacHistoryDTO {
  type: "capacity_factors";
  version: string;
  created_at: string;
  data: GeneratingUnitDTO[];
}

// ============================================================================
// Coal-generation stats (the /api/stats contract)
//
// Absolute generation (MWh) is reconstructed server-side from the capacity-
// factor payloads (energy = CF/100 × capacity × 24) and aggregated per region /
// network into peak and most-recent figures at four granularities. See
// src/server/coal-stats-service.ts.
// ============================================================================

/** How complete a period's data is, in unit-days (one unit × one day). */
export interface PeriodCoverage {
  // Days the unit(s) were alive in this period (commissioned, not yet retired).
  expectedUnitDays: number;
  // Alive unit-days that actually have a reading.
  presentUnitDays: number;
  // Alive unit-days that are MISSING (interior gaps / holes in the data).
  holeUnitDays: number;
  // presentUnitDays / expectedUnitDays (1 when nothing was expected).
  coverage: number;
  // Observed total scaled to full coverage (an estimate of the true value when
  // holes exist); null when there are no holes or nothing was observed.
  estimatedFullTotal: number | null;
}

/** One peak or most-recent value at a given granularity. */
export interface StatValue {
  total: number; // MWh over the period
  avgPerDay: number; // MWh per calendar day of the period
  label: string; // e.g. '20 Jul 2007', 'Jul 2007', 'Q3 2007', '2007'
  start: string; // ISO date, first day of the period
  end: string; // ISO date, last day of the period
  coverage: PeriodCoverage;
}

/** Peak, most-recent, and the recent-as-proportion-of-peak, for one granularity. */
export interface GranularityStat {
  peak: StatValue | null; // null if the row never had data at this granularity
  recent: StatValue | null; // null if the latest complete period has no data for this row
  proportion: number | null; // recent.total / peak.total, in [0, ~1]; null if either is missing
}

/** One row of the stats table: a region, a network aggregate, or the total. */
export interface StatRow {
  key: string; // 'NSW1' | 'QLD1' | 'SA1' | 'VIC1' | 'NEM' | 'WEM' | 'ALL'
  kind: 'region' | 'network' | 'total';
  label: { long: string; short: string };
  day: GranularityStat;
  month: GranularityStat;
  quarter: GranularityStat;
  year: GranularityStat;
}

/** A contiguous run of missing days for a unit that was alive throughout. */
export interface DataGap {
  duid: string;
  region: string; // NEM region code, or 'WEM'
  start: string; // ISO date (inclusive)
  end: string; // ISO date (inclusive)
  days: number;
}

/** The full /api/stats payload. */
export interface CoalGenerationStatsDTO {
  type: 'coal_generation_stats';
  version: string;
  created_at: string;
  fleet: FleetMode;
  latestDataDay: string; // ISO date of the most recent day of data
  units: 'MWh';
  rows: StatRow[];
  dataQuality: {
    totalHoleUnitDays: number;
    gaps: DataGap[]; // every gap, sorted longest-first
  };
}

// Clean internal representations for the client
export interface GeneratingUnit {
  unitId: string;  // This is the DUID
  unitName: string; // This could be formatted differently from unitId
  capacity: number;
  history: UnitHistoryDTO;
}

export interface Facility {
  network: string;
  region?: string; // NEM region code; undefined for WEM units
  facilityCode: string;
  facilityName: string;
  units: GeneratingUnit[];
}
