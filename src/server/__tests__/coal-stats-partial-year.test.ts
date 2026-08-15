/**
 * The stats fold across the partial first year.
 *
 * 1998 holds only 7–31 December, but the payload for it is a full 365-entry
 * array like any other year: the server always asks for 1 Jan → 31 Dec and
 * OpenElectricity silently clips. So the fold's global day index 0 sits at
 * 1998-12-07 while the payload's `history.start` sits at 1998-01-01, giving a
 * base offset of -340 and 340 array entries that map to negative indices.
 *
 * Two things have to hold, and neither had coverage before the boundary moved:
 * those 340 entries must be dropped rather than wrapping or shifting the
 * series, and a null run that straddles New Year must still fold into ONE gap.
 */
import { describe, expect, it } from 'vitest';
import { computeCoalStats, type YearReader } from '@/server/coal-stats-service';
import type { GeneratingUnitCapFacHistoryDTO, GeneratingUnitDTO } from '@/shared/types';

const DAYS_1998 = 365;
const DAYS_1999 = 365;
/** 0-based day-of-year of 7 December in a non-leap year. */
const DEC_7 = 340;
/** 0-based day-of-year of 24 December in a non-leap year. */
const DEC_24 = 357;
/** 0-based day-of-year of 19 January. */
const JAN_19 = 18;

function unit(year: number, data: (number | null)[]): GeneratingUnitDTO {
  return {
    network: 'nem',
    region: 'NSW1',
    data_type: 'capacity_factor',
    units: '%',
    capacity: 660,
    duid: 'BW01',
    facility_code: 'BAYSW',
    facility_name: 'Bayswater',
    fueltech: 'coal_black',
    status: 'operating',
    // Commissioned long before the record starts — this is what makes
    // lifecycleBounds clamp to index 0 on the client, and what makes every
    // pre-record null on the server a candidate for an interior gap.
    commenced: '1985-01-01',
    history: {
      start: `${year}-01-01`,
      last: `${year}-12-31`,
      interval: '1d',
      data,
    },
  };
}

function payload(year: number, data: (number | null)[]): GeneratingUnitCapFacHistoryDTO {
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: `${year}-01-01T00:00:00+10:00`,
    data: [unit(year, data)],
  };
}

/** Reads the two years under test; every other year is empty. */
function reader(d1998: (number | null)[], d1999: (number | null)[]): YearReader {
  return async (year) => {
    if (year === 1998) return payload(1998, d1998);
    if (year === 1999) return payload(1999, d1999);
    return { type: 'capacity_factors', version: '1.0', created_at: '', data: [] };
  };
}

/** A year of nulls with `run` filled in from `from` (inclusive). */
function withRun(length: number, from: number, run: number, value = 60): (number | null)[] {
  const data: (number | null)[] = new Array(length).fill(null);
  for (let i = from; i < from + run; i++) data[i] = value;
  return data;
}

describe('computeCoalStats across the partial 1998 year', () => {
  it('drops the 340 pre-record entries instead of folding them into the timeline', async () => {
    // Data every day from 7 Dec 1998 to the end of 1999: no holes at all.
    const d1998 = withRun(DAYS_1998, DEC_7, DAYS_1998 - DEC_7);
    const d1999 = withRun(DAYS_1999, 0, DAYS_1999);

    const stats = await computeCoalStats(reader(d1998, d1999));

    // Jan–Nov 1998 are null in the payload but sit at negative global indices,
    // so they are neither gaps nor generation.
    expect(stats.dataQuality.gaps).toEqual([]);
    expect(stats.dataQuality.totalHoleUnitDays).toBe(0);
  });

  it('folds a null run straddling New Year into one gap, not two', async () => {
    // Data 7–23 Dec 1998, then nothing until 20 Jan 1999.
    const d1998 = withRun(DAYS_1998, DEC_7, DEC_24 - DEC_7);
    const d1999 = withRun(DAYS_1999, JAN_19 + 1, DAYS_1999 - JAN_19 - 1);

    const stats = await computeCoalStats(reader(d1998, d1999));
    const gaps = stats.dataQuality.gaps.filter((g) => g.duid === 'BW01');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      start: '1998-12-24',
      end: '1999-01-19',
      days: 27,
    });
  });

  it('never reports a gap starting before the first day of the record', async () => {
    // The unit only appears on 21 Dec 1998 — the 14 nulls from 7 Dec precede its
    // first data day, so they are pre-commission, not a hole.
    const d1998 = withRun(DAYS_1998, DEC_7 + 14, DAYS_1998 - DEC_7 - 14);
    const d1999 = withRun(DAYS_1999, 0, DAYS_1999);

    const stats = await computeCoalStats(reader(d1998, d1999));

    expect(stats.dataQuality.gaps).toEqual([]);
    for (const gap of stats.dataQuality.gaps) {
      expect(gap.start >= '1998-12-07').toBe(true);
    }
  });

  it('counts 1998 as a source year', async () => {
    const d = withRun(DAYS_1998, DEC_7, DAYS_1998 - DEC_7);
    const stats = await computeCoalStats(reader(d, withRun(DAYS_1999, 0, DAYS_1999)));

    expect(stats.sources!.years[0].year).toBe(1998);
  });
});
