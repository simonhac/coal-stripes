// Type definitions for capacity factor visualisation.
//
// The DTO types below define the JSON contract between our server route
// (/api/capacity-factors) and the client — the client never sees raw
// OpenElectricity responses, only this shape.

// Which roster of coal units the visualisation shows. `full` = every unit that
// ever operated across recorded history (includes retired plants); `current` =
// only units operating in the present year. The mode selects which rows exist;
// missing cells (e.g. a unit before it was commissioned, or WEM pre-2006) still
// render as the "no data" (null) pale blue.
//
// This is a VIEW selector, not a server query parameter. The server always
// serves the full roster (each unit tagged with its `status`), and `current` is
// derived from it by filtering — see @/shared/fleet-filter. It therefore
// appears in the client query key but in no server cache key or request URL.
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
  // The unit's operating status as at the time the payload was built — NOT as
  // at the payload's year. A unit retired in 2012 is 'retired' in every year's
  // payload, including 1999 when it was running. This is what lets the client
  // derive the `current` fleet view without a second request; see
  // @/shared/fleet-filter.
  status: 'operating' | 'retired';
  // When this unit existed, from OpenElectricity's unit metadata — NOT inferred
  // from the year in `history`, which is what lets a gap straddling 31 Dec be
  // told apart from a commissioning. `commenced` is the pre-commission boundary
  // and is the field to trust; `first_seen`/`last_seen` are the data frontier
  // and may lag it badly (`data_first_seen` reports the start of the later
  // contiguous run for units with early gaps), so they may only widen an
  // observed span, never narrow it. Optional: payloads cached before these
  // fields existed still satisfy the contract, and consumers fall back to
  // inferring the span from the values.
  commenced?: string | null; // ISO date
  commenced_specificity?: UnitDateSpecificity | null;
  first_seen?: string | null; // ISO date
  last_seen?: string | null; // ISO date
  history: UnitHistoryDTO;

  // ---- Data-quality accounting -------------------------------------------
  // The three fields below exist so /stats can state what OpenElectricity
  // actually holds, not merely what survives our own folding. None affects the
  // visualisation; see @/server/coal-stats-service for how each is consumed.

  // Set when this unit's readings are folded into another DUID's row (see
  // SUPERSEDED_BY in @/server/cap-fac-data-service). Such a row belongs to NO
  // fleet view — @/shared/fleet-filter drops it — and contributes no generation,
  // because its energy is already counted in the absorbing row. It is emitted
  // solely so the fold can see the member's own nulls, which folding would
  // otherwise make invisible. Its `history` is the member's RAW pattern: no
  // retired-unit 0-fill, no pre-commission blanking, so a null here means
  // OpenElectricity had nothing for that day.
  foldedInto?: string | null;
  // For a row that absorbs other DUIDs, this unit's OWN readings without them,
  // filled by the same raw rules as a folded member's `history`. Lets the fold
  // separate the absorbing row's own gaps from those it inherited by starting at
  // its members' first reading. Absent on every unit that absorbs nothing.
  selfHistory?: UnitHistoryDTO;
  // Days where the retired-unit 0-fill wrote 0 over a day OpenElectricity
  // explicitly returned as null — real holes this payload hides. Arises when
  // `data_last_seen` under-reports a unit's final reading, as it does for LD03
  // (claims 2022-04-02; the daily series runs to 2022-07-19).
  suppressedNullDays?: number;
}

/** How precisely OpenElectricity knows a lifecycle date. */
export type UnitDateSpecificity = 'year' | 'quarter' | 'month' | 'day';

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

/**
 * A known divergence between the gaps we count and what OpenElectricity holds.
 *
 * `totalHoleUnitDays` counts only the rows we emit, so three of our own
 * decisions hide real upstream nulls (folding members into an aggregate) or
 * invent coverage (the retired-unit 0-fill). Each is reported here rather than
 * silently absorbed, so /stats can foot up to the unit-level figure a reader
 * would get by querying OpenElectricity directly.
 *
 * `unitDays` is signed: positive adds days we don't count, negative credits back
 * days we count twice.
 */
export interface GapAdjustment {
  key: string; // stable identifier, e.g. 'folded-members'
  label: string; // one line, as rendered in the table
  unitDays: number; // signed
  note: string; // why this divergence exists
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
/**
 * Provenance of the per-year capacity-factor payloads a stats result was built
 * from. `builtAt` is each payload's own `created_at` — the moment it was last
 * assembled from OpenElectricity, NOT when it was read out of a cache — so it
 * answers "how old is the data I'm looking at?" honestly however many cache
 * layers served it. See computeCoalStats in @/server/coal-stats-service.
 */
export interface StatsSourceYear {
  year: number;
  builtAt: string | null; // null when that year's fetch failed
}

export interface StatsSources {
  years: StatsSourceYear[];
  oldestBuiltAt: string | null; // null when no year resolved
  newestBuiltAt: string | null;
}

/**
 * The full /api/stats payload.
 *
 * Whole-of-history records over every coal unit that ever operated. There is no
 * fleet view here and no `?fleet=` parameter: /stats has only ever asked for the
 * full fleet, and a "records since 1998" table that excluded retired plants
 * would omit most of the records worth reporting — Hazelwood and Liddell are the
 * point, not an edge case.
 *
 * FleetMode remains what it says it is: a view selector for the visualisation,
 * applied client-side over the capacity-factors roster. It appears in no server
 * cache key or request URL, here or anywhere.
 */
export interface CoalGenerationStatsDTO {
  type: 'coal_generation_stats';
  version: string;
  created_at: string;
  latestDataDay: string; // ISO date of the most recent day of data
  units: 'MWh';
  rows: StatRow[];
  dataQuality: {
    // Holes in the rows we emit — the sum of `gaps` below.
    totalHoleUnitDays: number;
    gaps: DataGap[]; // every gap, sorted longest-first
    // Signed corrections from `totalHoleUnitDays` to `totalUnitDaysAtSource`.
    // Optional so a payload cached before they existed still type-checks; the
    // table then shows the counted total alone.
    adjustments?: GapAdjustment[];
    // What a reader querying OpenElectricity per-DUID would count:
    // totalHoleUnitDays + Σ adjustments. This is the honest headline.
    totalUnitDaysAtSource?: number;
  };
  // Optional so a payload cached before this field existed still type-checks —
  // the stats page renders the recency line only when it is present.
  sources?: StatsSources;
}

// Clean internal representations for the client
export interface GeneratingUnit {
  unitId: string;  // This is the DUID
  unitName: string; // This could be formatted differently from unitId
  capacity: number;
  // Lifecycle dates as carried on the DTO — see GeneratingUnitDTO. The stripe
  // renderer needs them to tell a cross-year gap from a commissioning.
  commenced?: string | null;
  lastSeen?: string | null;
  // Retired as at the time the payload was built, not as at its year — see the
  // note on GeneratingUnitDTO.status.
  status?: 'operating' | 'retired';
  history: UnitHistoryDTO;
}

export interface Facility {
  network: string;
  region?: string; // NEM region code; undefined for WEM units
  facilityCode: string;
  facilityName: string;
  units: GeneratingUnit[];
}
