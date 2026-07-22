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
