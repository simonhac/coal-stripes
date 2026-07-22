/**
 * Behavioural tests for the two fleet roster modes and per-network error
 * tolerance. The OpenElectricity SDK client is mocked so we can control which
 * networks/units return data (or a NoDataFound) without touching the real API.
 */
import { CapFacDataService } from '@/server/cap-fac-data-service';
import { parseDate } from '@internationalized/date';
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
    ...over,
  };
}

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
