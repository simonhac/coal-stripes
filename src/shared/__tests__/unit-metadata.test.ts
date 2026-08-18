/**
 * The join between a year's values and what its DUIDs are.
 *
 * The interesting cases are all disagreements. A year file and the metadata blob
 * are separately cached — the blob rides in an SSR document held at the edge for
 * an hour, the years in Workers Cache for up to a week — so they can be a little
 * out of step with each other, and what happens then is a design decision rather
 * than an accident. See @/shared/unit-metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateYear, regionKey } from '../unit-metadata';
import type { UnitMetadata, YearCapFacHistoryDTO } from '../types';

const meta = (over: Partial<UnitMetadata> = {}): UnitMetadata => ({
  network: 'nem',
  region: 'NSW1',
  capacity: 660,
  facility_code: 'BAYSW',
  facility_name: 'Bayswater',
  fueltech: 'coal_black',
  status: 'operating',
  ...over,
});

const year = (...duids: string[]): YearCapFacHistoryDTO => ({
  type: 'capacity_factors',
  version: 'v3',
  created_at: '2026-08-18T00:01:13+10:00',
  data: duids.map((duid) => ({
    duid,
    history: { start: '2024-01-01', last: '2024-01-03', interval: '1d', data: [50, null, 70] },
  })),
});

describe('hydrateYear', () => {
  // Restored rather than merely cleared: a spy left on `console.warn` would
  // accumulate calls across these tests, and several of them assert on the count.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts a unit back together without touching its values', () => {
    const dto = year('BW01');
    const joined = hydrateYear(dto, { BW01: meta() });

    expect(joined.data).toHaveLength(1);
    expect(joined.data[0]).toMatchObject({
      duid: 'BW01',
      capacity: 660,
      facility_name: 'Bayswater',
      region: 'NSW1',
      status: 'operating',
    });
    // The null in the middle is a missing reading, never a zero.
    expect(joined.data[0].history.data).toEqual([50, null, 70]);
    expect(joined.created_at).toBe(dto.created_at);
  });

  it('keeps the payload order, which is the roster display order', () => {
    const joined = hydrateYear(year('C', 'A', 'B'), {
      A: meta(), B: meta(), C: meta(),
    });

    expect(joined.data.map((u) => u.duid)).toEqual(['C', 'A', 'B']);
  });

  it('lets the year payload win on the fields it owns', () => {
    // `duid` is in both halves by construction. If the blob ever disagreed, the
    // year file is the one that decides which row these values belong to.
    const joined = hydrateYear(year('BW01'), {
      BW01: { ...meta(), duid: 'WRONG' } as UnitMetadata & { duid: string },
    });

    expect(joined.data[0].duid).toBe('BW01');
  });

  it('drops a DUID the metadata has never heard of, and says so once', () => {
    const joined = hydrateYear(year('BW01', 'NEW01', 'NEW02'), { BW01: meta() });

    // The other rows still render — a unit that appeared upstream inside the
    // document's cache window must not take the whole chart down with it.
    expect(joined.data.map((u) => u.duid)).toEqual(['BW01']);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('NEW01, NEW02');
  });

  it('ignores a unit the metadata knows but the year does not mention', () => {
    // A unit commissioned after this year simply has no row in it.
    const joined = hydrateYear(year('BW01'), { BW01: meta(), FUTURE: meta() });

    expect(joined.data.map((u) => u.duid)).toEqual(['BW01']);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('renders nothing rather than something wrong when there is no metadata', () => {
    // No capacity means no row height and no facility to group under, so there
    // is no honest partial render available here.
    const joined = hydrateYear(year('BW01'), null);

    expect(joined.data).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('regionKey', () => {
  it('keys NEM units by their region code', () => {
    expect(regionKey('nem', 'NSW1')).toBe('NSW1');
  });

  it('keys WEM units as their own region, since it is a separate data feed', () => {
    // OpenElectricity reports 'WEM' as the region, so this is the normal path…
    expect(regionKey('wem', 'WEM')).toBe('WEM');
    // …and this is the guard for a WEM facility that arrives without one.
    expect(regionKey('wem', undefined)).toBe('WEM');
    expect(regionKey('WEM', null)).toBe('WEM');
  });

  it('never invents a region', () => {
    expect(regionKey('nem', undefined)).toBe('UNKNOWN');
  });
});
