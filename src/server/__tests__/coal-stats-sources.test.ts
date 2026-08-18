/**
 * The stats payload must state where its data came from and how old it is.
 *
 * /stats is assembled from ~28 per-year payloads, so a stale store and a genuine
 * upstream data gap look identical on the page. The `sources` block is what
 * tells them apart: each year's `builtAt` is the moment that payload was last
 * assembled from OpenElectricity. These tests pin the behaviour that matters —
 * every requested year is accounted for, a year that failed to load is reported
 * as null rather than silently dropped, and the oldest/newest extremes are
 * correct.
 *
 * `computeCoalStats` takes its year reader as a parameter, so these drive it
 * directly rather than stubbing a transport. The aggregation itself is exercised
 * elsewhere.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCoalStats,
  type UnitMetadataReader,
  type YearReader,
} from '@/server/coal-stats-service';
import { earliestDataYear, currentDataYear } from '@/server/data-years';
import type { UnitMetadata, YearCapFacHistoryDTO } from '@/shared/types';
import { makeUnitMetadata } from './helpers/metadata';

/** A minimal, unit-free payload: enough shape for the provenance path. */
function payload(createdAt: string): YearCapFacHistoryDTO {
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: createdAt,
    data: [],
  };
}

/** No units at all — the provenance tests read nothing but `created_at`. */
const noUnits: UnitMetadataReader = async () => makeUnitMetadata({});

/** Stamp for a year, so each year is distinguishable. */
const stampFor = (year: number): string =>
  `${String(year).padStart(4, '0')}-03-04T05:06:07+10:00`;

/** A reader where `failYears` come back null, as an unbuildable year does. */
function reader(failYears: number[] = []): YearReader {
  return async (year) => (failYears.includes(year) ? null : payload(stampFor(year)));
}

const allYears = (): number[] => {
  const years: number[] = [];
  for (let y = earliestDataYear(); y <= currentDataYear(); y++) years.push(y);
  return years;
};

interface UnitSpec {
  duid: string;
  days: string;
  foldedInto?: string;
  self?: string;
  suppressedNullDays?: number;
}

/**
 * A payload holding one unit, whose daily values are given as a string: '.' is a
 * null day, a digit is that capacity factor. Keeps the gap shapes below legible.
 *
 * Returns the metadata alongside it, because a year payload no longer says what
 * a DUID *is* — `capacity`, `region` and `foldedInto` all live in the blob now,
 * and the fold reads all three. See @/shared/unit-metadata.
 */
function unitPayload(year: number, units: UnitSpec[]): YearCapFacHistoryDTO {
  const history = (days: string) => ({
    start: `${year}-01-01`,
    last: `${year}-01-${String(days.length).padStart(2, '0')}`,
    interval: '1d',
    data: [...days].map((c) => (c === '.' ? null : Number(c))),
  });
  return {
    type: 'capacity_factors',
    version: '1.0',
    created_at: stampFor(year),
    data: units.map((u) => ({
      duid: u.duid,
      history: history(u.days),
      ...(u.self ? { selfHistory: history(u.self) } : {}),
      ...(u.suppressedNullDays ? { suppressedNullDays: u.suppressedNullDays } : {}),
    })),
  };
}

function unitMetadata(units: UnitSpec[]): UnitMetadataReader {
  const over: Record<string, Partial<UnitMetadata>> = {};
  for (const u of units) {
    over[u.duid] = {
      region: 'SA1',
      capacity: 100,
      facility_code: 'F',
      facility_name: 'F',
      status: 'retired',
      ...(u.foldedInto ? { foldedInto: u.foldedInto } : {}),
    };
  }
  return async () => makeUnitMetadata(over);
}

describe('computeCoalStats — gap adjustments', () => {
  // The first FULL year of the record. Not earliestDataYear(): that year starts
  // mid-December, so a payload dated 1 January would sit before the timeline's
  // origin and every day would be clipped away.
  const YEAR = earliestDataYear() + 1;
  const only = (dto: YearCapFacHistoryDTO): YearReader =>
    async (year) => (year === YEAR ? dto : payload(stampFor(year)));

  /** The pair a fold needs: this year's values, and what its DUIDs are. */
  const fold = (units: UnitSpec[]) =>
    computeCoalStats(only(unitPayload(YEAR, units)), unitMetadata(units));

  it('counts a folded member\'s own gaps, which no row would show', async () => {
    // The aggregate has no interior gap; the member it absorbed has two.
    const stats = await fold([
      { duid: 'AGG', days: '5555' },
      { duid: 'MEM1', days: '5..5', foldedInto: 'AGG' },
    ]);
    const dq = stats.dataQuality;

    // The member is accounted for but never rendered as a gap row.
    expect(dq.totalHoleUnitDays).toBe(0);
    expect(dq.gaps).toEqual([]);

    const folded = dq.adjustments!.find((a) => a.key === 'folded-into-AGG')!;
    expect(folded.unitDays).toBe(2);
    expect(folded.label).toContain('MEM1');
    expect(dq.totalUnitDaysAtSource).toBe(2);
  });

  it('credits back the span an absorbing row inherits from its members', async () => {
    // The row runs day 1-4 with a hole at day 2 (inherited: the member's data
    // starts first). Its OWN series starts at day 3, so that hole is not its.
    const stats = await fold([{ duid: 'AGG', days: '5.55', self: '..55' }]);
    const dq = stats.dataQuality;

    expect(dq.totalHoleUnitDays).toBe(1);
    const span = dq.adjustments!.find((a) => a.key === 'absorbing-span-AGG')!;
    expect(span.unitDays).toBe(-1);
    // Counted once as the member's, not twice.
    expect(dq.totalUnitDaysAtSource).toBe(0);
  });

  it('adds back nulls the retired-unit 0-fill covered', async () => {
    const stats = await fold([{ duid: 'LD', days: '5005', suppressedNullDays: 2 }]);
    const dq = stats.dataQuality;

    // The fill already turned those days into zeros, so nothing reads as a gap.
    expect(dq.totalHoleUnitDays).toBe(0);
    const fill = dq.adjustments!.find((a) => a.key === 'retired-fill')!;
    expect(fill.unitDays).toBe(2);
    expect(fill.label).toContain('LD');
    expect(dq.totalUnitDaysAtSource).toBe(2);
  });

  it('omits an adjustment worth nothing, and always foots up', async () => {
    const stats = await fold([
      { duid: 'AGG', days: '55' },
      { duid: 'M', days: '55', foldedInto: 'AGG' },
    ]);
    const dq = stats.dataQuality;

    expect(dq.adjustments).toEqual([]);
    expect(dq.totalUnitDaysAtSource).toBe(dq.totalHoleUnitDays);
  });
});

describe('computeCoalStats — data provenance', () => {
  it('records a builtAt for every year it read', async () => {
    const stats = await computeCoalStats(reader(), noUnits);
    const sources = stats.sources;

    expect(sources).toBeDefined();
    expect(sources!.years.map((s) => s.year)).toEqual(allYears());
    for (const s of sources!.years) {
      expect(s.builtAt).toBe(stampFor(s.year));
    }
  });

  it('reports the oldest and newest payload build times', async () => {
    const sources = (await computeCoalStats(reader(), noUnits)).sources!;

    // stampFor is ordered by year, so the extremes are the range endpoints.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
    expect(sources.newestBuiltAt).toBe(stampFor(currentDataYear()));
  });

  it('marks a year that failed to load as null rather than dropping it', async () => {
    const failed = currentDataYear() - 1;

    const sources = (await computeCoalStats(reader([failed]), noUnits)).sources!;
    const entry = sources.years.find((s) => s.year === failed);

    expect(entry).toEqual({ year: failed, builtAt: null });
    // A missing year must not become the "oldest" — nulls are excluded.
    expect(sources.oldestBuiltAt).toBe(stampFor(earliestDataYear()));
  });

  it('reports nulls when no year could be loaded at all', async () => {
    const sources = (await computeCoalStats(reader(allYears()), noUnits)).sources!;

    expect(sources.oldestBuiltAt).toBeNull();
    expect(sources.newestBuiltAt).toBeNull();
    expect(sources.years.every((s) => s.builtAt === null)).toBe(true);
  });
});
