/**
 * Behavioural tests for the two fleet roster modes and per-network error
 * tolerance. The OpenElectricity SDK client is mocked so we can control which
 * networks/units return data (or a NoDataFound) without touching the real API.
 */
import { CapFacDataService } from '@/server/cap-fac-data-service';
import { parseDate } from '@internationalized/date';
import { getDaysBetween, getTodayAEST } from '@/shared/date-utils';
import { setupTestLogger, cleanupTestLogger } from '../test-helpers';

// The mock must provide a real NoDataFound class (defined inside the factory to
// satisfy jest's hoisting) — the service uses `instanceof NoDataFound` to
// classify tolerable "no data" errors.
jest.mock('openelectricity', () => {
  class NoDataFound extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoDataFound';
    }
  }
  return {
    OpenElectricityClient: jest.fn(),
    NoDataFound,
  };
});

import { OpenElectricityClient, NoDataFound } from 'openelectricity';

const ClientMock = OpenElectricityClient as unknown as jest.Mock;
const getFacilities = jest.fn();
const getFacilityData = jest.fn();

const YEAR = 2019; // a past, non-leap year: all days carry data (none future-nulled)

interface MockUnit {
  facility_code: string;
  facility_name: string;
  facility_network: string;
  facility_region: string;
  unit_code: string;
  unit_fueltech: string;
  unit_capacity: number | null;
  // From the /facilities endpoint. A 'retired' unit's days after unit_last_seen
  // (its last day of data) are filled with 0 (decommissioned red), not null.
  unit_status: string | null;
  unit_last_seen: string | null;
}

function unitRecord(over: Partial<MockUnit>): MockUnit {
  return {
    facility_code: 'FAC',
    facility_name: 'Facility',
    facility_network: 'NEM',
    facility_region: 'NSW1',
    unit_code: 'U1',
    unit_fueltech: 'coal_black',
    unit_capacity: 100,
    unit_status: null,
    unit_last_seen: null,
    ...over,
  };
}

// Rows of a steady 50% capacity factor (energy 1200 MWh/day, capacity 100 MW) for
// the given inclusive date range — used to model a retired unit whose data ends.
function rowsForRange(unitCode: string, network: string, start: string, end: string): unknown[] {
  const tz = network === 'WEM' ? '+08:00' : '+10:00';
  const rows: unknown[] = [];
  let d = parseDate(start);
  const last = parseDate(end);
  while (d.compare(last) <= 0) {
    rows.push({ interval: new Date(`${d.toString()}T00:00:00${tz}`), unit_code: unitCode, energy: 1200 });
    d = d.add({ days: 1 });
  }
  return rows;
}

// Day-of-year index (0-based) of a date within its year — the index into history.data.
const dayIndex = (isoDate: string): number =>
  getDaysBetween(parseDate(`${parseDate(isoDate).year}-01-01`), parseDate(isoDate));

// Daily energy rows for one unit across the year → a steady 50% capacity factor.
function yearRows(unitCode: string, network: string): unknown[] {
  const tz = network === 'WEM' ? '+08:00' : '+10:00';
  const rows: unknown[] = [];
  let d = parseDate(`${YEAR}-01-01`);
  const end = parseDate(`${YEAR}-12-31`);
  while (d.compare(end) <= 0) {
    rows.push({ interval: new Date(`${d.toString()}T00:00:00${tz}`), unit_code: unitCode, energy: 1200 });
    d = d.add({ days: 1 });
  }
  return rows;
}

beforeAll(() => setupTestLogger());
afterAll(() => cleanupTestLogger());

beforeEach(() => {
  jest.clearAllMocks();
  ClientMock.mockImplementation(() => ({
    getFacilities: (...a: unknown[]) => getFacilities(...a),
    getFacilityData: (...a: unknown[]) => getFacilityData(...a),
  }));
});

describe('fleet modes', () => {
  it('full mode emits an all-null row for a roster unit with no data; current mode drops it', async () => {
    getFacilities.mockResolvedValue({
      table: {
        getRecords: () => [
          unitRecord({ facility_code: 'WITHDATA', facility_name: 'With Data', unit_code: 'WD01' }),
          unitRecord({ facility_code: 'NODATA', facility_name: 'No Data', unit_code: 'ND01' }),
        ],
      },
    });
    // The single NEM request returns rows only for WD01 — ND01 has no rows.
    getFacilityData.mockImplementation((_network: string, codes: string[]) =>
      Promise.resolve({
        datatable: { getRows: () => (codes.includes('WITHDATA') ? yearRows('WD01', 'NEM') : []) },
      })
    );

    const service = new CapFacDataService('key');

    const full = await service.getCapacityFactors(YEAR, 'full');
    const fullDuids = full.data.map((u) => u.duid);
    expect(fullDuids).toContain('WD01');
    expect(fullDuids).toContain('ND01'); // present as an all-null row

    const nd = full.data.find((u) => u.duid === 'ND01')!;
    expect(nd.history.data.every((v) => v === null)).toBe(true);
    const wd = full.data.find((u) => u.duid === 'WD01')!;
    expect(wd.history.data.some((v) => v !== null)).toBe(true);

    const current = await service.getCapacityFactors(YEAR, 'current');
    const currentDuids = current.data.map((u) => u.duid);
    expect(currentDuids).toContain('WD01');
    expect(currentDuids).not.toContain('ND01'); // dropped — no data this year
  });

  it('tolerates a network with no data (NoDataFound) and still returns the other network', async () => {
    getFacilities.mockResolvedValue({
      table: {
        getRecords: () => [
          unitRecord({ facility_code: 'NEMFAC', facility_name: 'Nem Fac', unit_code: 'NEM01' }),
          unitRecord({
            facility_code: 'WEMFAC',
            facility_name: 'Wem Fac',
            facility_network: 'WEM',
            facility_region: 'WEM',
            unit_code: 'WEM01',
          }),
        ],
      },
    });
    // WEM has no data for the range (as it does before 2006) → NoDataFound.
    getFacilityData.mockImplementation((network: string) =>
      network === 'WEM'
        ? Promise.reject(new NoDataFound('No data found for the requested parameters'))
        : Promise.resolve({ datatable: { getRows: () => yearRows('NEM01', 'NEM') } })
    );

    const service = new CapFacDataService('key');

    // Must NOT throw despite WEM being empty.
    const full = await service.getCapacityFactors(YEAR, 'full');
    const nem = full.data.find((u) => u.duid === 'NEM01')!;
    expect(nem.history.data.some((v) => v !== null)).toBe(true);
    const wem = full.data.find((u) => u.duid === 'WEM01')!;
    expect(wem.history.data.every((v) => v === null)).toBe(true);
  });

  it('propagates a non-NoDataFound upstream error rather than swallowing it', async () => {
    getFacilities.mockResolvedValue({
      table: { getRecords: () => [unitRecord({ facility_code: 'NEMFAC', unit_code: 'NEM01' })] },
    });
    // A non-network TypeError aborts p-retry immediately (no backoff wait).
    getFacilityData.mockRejectedValue(new TypeError('upstream failure'));

    const service = new CapFacDataService('key');
    await expect(service.getCapacityFactors(YEAR, 'full')).rejects.toThrow();
  }, 10000);
});

describe('retired-unit colouring (fill precedence)', () => {
  // A retired plant whose data ended mid-2019. Data runs Jan 1–Jun 30, then a
  // single stray reading on Aug 15 (a metadata `unit_last_seen` that lags the
  // real series). unit_last_seen = 2019-06-30.
  const RETIRED = {
    facility_code: 'LIDDELL',
    facility_name: 'Liddell',
    unit_code: 'LD01',
    unit_status: 'retired',
    unit_last_seen: '2019-06-30T08:00:00+10:00',
  };

  it('fills a retired unit red (0) from last generation to today, but a real reading still wins', async () => {
    // YEAR (2019) is entirely in the past, so no day is future-nulled.
    getFacilities.mockResolvedValue({
      table: { getRecords: () => [unitRecord(RETIRED)] },
    });
    const rows = [
      ...rowsForRange('LD01', 'NEM', `${YEAR}-01-01`, `${YEAR}-06-30`),
      ...rowsForRange('LD01', 'NEM', `${YEAR}-08-15`, `${YEAR}-08-15`), // stray reading after unit_last_seen
    ];
    getFacilityData.mockResolvedValue({ datatable: { getRows: () => rows } });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'LD01')!.history.data;

    expect(data[dayIndex(`${YEAR}-01-15`)]).toBe(50); // real generation early
    expect(data[dayIndex(`${YEAR}-07-15`)]).toBe(0); // past, no data, retired → red
    expect(data[dayIndex(`${YEAR}-08-15`)]).toBe(50); // a real reading beats the synthetic 0
    expect(data[dayIndex(`${YEAR}-12-31`)]).toBe(0); // still red at year end
    // A fully-past retired year has no nulls: every day is either CF or 0 (red).
    expect(data.every((v) => v !== null)).toBe(true);
  });

  it('never paints a retired unit red into the future — future days are null, not 0', async () => {
    // A whole year in the future: every day is >= today, so nothing may be filled
    // with the decommissioned 0 even though the unit retired years ago.
    const futureYear = getTodayAEST().add({ years: 2 }).year;
    getFacilities.mockResolvedValue({
      table: { getRecords: () => [unitRecord(RETIRED)] },
    });
    getFacilityData.mockResolvedValue({ datatable: { getRows: () => [] } });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(futureYear, 'full');
    const data = full.data.find((u) => u.duid === 'LD01')!.history.data;

    expect(data.every((v) => v === null)).toBe(true); // background, not red
  });
});
