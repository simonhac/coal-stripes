/**
 * The `current` fleet view is derived from the full-roster payload rather than
 * fetched separately, so this filter is the whole definition of what `current`
 * means. It has to reproduce BOTH of the things the server used to do in
 * `current` mode — restrict the roster to operating units, and drop units with
 * no data for the year — or the view silently gains rows it never had.
 */
import { isInFleet, filterFleet } from '../fleet-filter';
import type { GeneratingUnitDTO, GeneratingUnitCapFacHistoryDTO } from '../types';

function unit(over: Partial<GeneratingUnitDTO> = {}): GeneratingUnitDTO {
  return {
    network: 'nem',
    region: 'NSW1',
    capacity: 700,
    duid: 'U1',
    facility_code: 'FAC',
    facility_name: 'Facility',
    fueltech: 'coal_black',
    status: 'operating',
    history: { start: '2015-01-01', last: '2015-12-31', interval: '1d', data: [50, 60, 70] },
    ...over,
  };
}

const allNull = { start: '2015-01-01', last: '2015-12-31', interval: '1d', data: [null, null, null] };

describe('isInFleet', () => {
  describe("mode 'full'", () => {
    it('keeps every unit, whatever its status or data', () => {
      expect(isInFleet(unit(), 'full')).toBe(true);
      expect(isInFleet(unit({ status: 'retired' }), 'full')).toBe(true);
      expect(isInFleet(unit({ history: allNull }), 'full')).toBe(true);
      expect(isInFleet(unit({ status: 'retired', history: allNull }), 'full')).toBe(true);
    });
  });

  describe("mode 'current'", () => {
    it('keeps an operating unit with data', () => {
      expect(isInFleet(unit(), 'current')).toBe(true);
    });

    it('drops a retired unit even when it has data for the year', () => {
      // A plant that ran in 2015 and closed in 2022 has real 2015 readings —
      // it is excluded because of what it is now, not what it did then.
      expect(isInFleet(unit({ status: 'retired' }), 'current')).toBe(false);
    });

    it('drops an operating unit with no data for the year', () => {
      // Not yet commissioned, or a year the collection never covered. The
      // server emits it as an all-null row; `current` omits the row entirely.
      expect(isInFleet(unit({ history: allNull }), 'current')).toBe(false);
    });

    it('keeps an operating unit whose only data is a zero', () => {
      // 0 means "ran, generated nothing" — real data, unlike null. Treating
      // the two alike here would drop units that were merely offline.
      expect(
        isInFleet(unit({ history: { ...allNull, data: [null, 0, null] } }), 'current'),
      ).toBe(true);
    });
  });
});

describe('filterFleet', () => {
  const dto: GeneratingUnitCapFacHistoryDTO = {
    type: 'capacity_factors',
    version: '1.0',
    created_at: '2026-08-07T10:00:00+10:00',
    data: [
      unit({ duid: 'LIVE' }),
      unit({ duid: 'RETIRED', status: 'retired' }),
      unit({ duid: 'NODATA', history: allNull }),
    ],
  };

  it('returns the identical object for full — no copy', () => {
    expect(filterFleet(dto, 'full')).toBe(dto);
  });

  it('keeps only the operating units with data for current', () => {
    expect(filterFleet(dto, 'current').data.map((u) => u.duid)).toEqual(['LIVE']);
  });

  it('preserves the envelope and shares unit objects rather than cloning them', () => {
    // Both views of a year point at the same units, which is what makes
    // holding both cheap — see the memory accounting in query-cache-stats.
    const filtered = filterFleet(dto, 'current');
    expect(filtered.created_at).toBe(dto.created_at);
    expect(filtered.type).toBe(dto.type);
    expect(filtered.data[0]).toBe(dto.data[0]);
  });

  it('does not mutate the payload it filters', () => {
    filterFleet(dto, 'current');
    expect(dto.data).toHaveLength(3);
  });
});
