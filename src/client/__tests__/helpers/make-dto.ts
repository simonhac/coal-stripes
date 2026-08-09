import { GeneratingUnitCapFacHistoryDTO } from '@/shared/types';

/**
 * A minimal capacity-factor payload, as the client's year builder expects it.
 * One flat capacity factor per unit for the whole year, which makes the
 * expected averages arithmetic you can do in your head.
 */
export interface UnitSpec {
  duid: string;
  facilityCode: string;
  region: string;
  capacity: number;
  /** Held for every day of the year. null means "no data", never zero. */
  capacityFactor: number | null;
  network?: string;
  status?: 'operating' | 'retired';
  // Lifecycle dates as OpenElectricity serves them: a date known only to the
  // year arrives as that year's 31 December.
  commenced?: string | null;
  lastSeen?: string | null;
}

/** Build a year's DTO. `year` only labels the history; the array is 365 long. */
export function makeDTO(units: UnitSpec[], year = 2023): GeneratingUnitCapFacHistoryDTO {
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: '2024-01-01T00:00:00+10:00',
    data: units.map(unit => ({
      network: unit.network ?? 'NEM',
      region: unit.region,
      data_type: 'capacity_factor',
      units: 'MW',
      capacity: unit.capacity,
      duid: unit.duid,
      facility_code: unit.facilityCode,
      facility_name: `${unit.facilityCode} Station`,
      fueltech: 'coal_black',
      status: unit.status ?? ('operating' as const),
      commenced: unit.commenced,
      last_seen: unit.lastSeen,
      history: {
        data: Array(365).fill(unit.capacityFactor),
        start: `${year}-01-01`,
        last: `${year}-12-31`,
        interval: '1d'
      }
    }))
  };
}
