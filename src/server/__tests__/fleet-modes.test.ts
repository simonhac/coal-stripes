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
  unit_first_seen: string | null;
  // When the machine was commissioned, as opposed to when its DUID started
  // reporting. Only honoured at 'day' specificity — see the service.
  commencement_date: string | null;
  commencement_date_specificity: string | null;
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
    unit_first_seen: null,
    commencement_date: null,
    commencement_date_specificity: null,
    ...over,
  };
}

/**
 * The /facilities response as the service reads it: the envelope, with units
 * nested under their facility. The service uses this rather than the SDK's
 * flattened `table` because only the envelope carries commencement_date.
 */
function facilitiesEnvelope(units: MockUnit[]) {
  const byFacility = new Map<string, MockUnit[]>();
  for (const unit of units) {
    byFacility.set(unit.facility_code, [...(byFacility.get(unit.facility_code) ?? []), unit]);
  }
  return {
    response: {
      data: Array.from(byFacility.values()).map((facilityUnits) => ({
        code: facilityUnits[0].facility_code,
        name: facilityUnits[0].facility_name,
        network_id: facilityUnits[0].facility_network,
        network_region: facilityUnits[0].facility_region,
        units: facilityUnits.map((u) => ({
          code: u.unit_code,
          fueltech_id: u.unit_fueltech,
          status_id: u.unit_status,
          capacity_registered: u.unit_capacity,
          data_first_seen: u.unit_first_seen,
          data_last_seen: u.unit_last_seen,
          commencement_date: u.commencement_date,
          commencement_date_specificity: u.commencement_date_specificity,
        })),
      })),
    },
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
    getFacilities.mockResolvedValue(
      facilitiesEnvelope([
        unitRecord({ facility_code: 'WITHDATA', facility_name: 'With Data', unit_code: 'WD01' }),
        unitRecord({ facility_code: 'NODATA', facility_name: 'No Data', unit_code: 'ND01' }),
      ])
    );
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
    getFacilities.mockResolvedValue(
      facilitiesEnvelope([
        unitRecord({ facility_code: 'NEMFAC', facility_name: 'Nem Fac', unit_code: 'NEM01' }),
        unitRecord({
          facility_code: 'WEMFAC',
          facility_name: 'Wem Fac',
          facility_network: 'WEM',
          facility_region: 'WEM',
          unit_code: 'WEM01',
        }),
      ])
    );
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
    getFacilities.mockResolvedValue(
      facilitiesEnvelope([unitRecord({ facility_code: 'NEMFAC', unit_code: 'NEM01' })])
    );
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
    getFacilities.mockResolvedValue(facilitiesEnvelope([unitRecord(RETIRED)]));
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
    getFacilities.mockResolvedValue(facilitiesEnvelope([unitRecord(RETIRED)]));
    getFacilityData.mockResolvedValue({ datatable: { getRows: () => [] } });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(futureYear, 'full');
    const data = full.data.find((u) => u.duid === 'LD01')!.history.data;

    expect(data.every((v) => v === null)).toBe(true); // background, not red
  });
});

describe('aggregate DUIDs (Playford B)', () => {
  // The real roster: four 60 MW unit DUIDs whose metering moved to one 240 MW
  // aggregate mid-year. OpenElectricity returns rows for the units up to the
  // handover and for the aggregate from it — never both for the same interval.
  const CHANGEOVER = `${YEAR}-05-26`;

  const playford = () =>
    facilitiesEnvelope([
      unitRecord({
        facility_code: 'PLAYF',
        facility_name: 'Playford B',
        facility_region: 'SA1',
        unit_code: 'PLAYB-AG',
        unit_capacity: 240,
        unit_status: 'retired',
        unit_last_seen: `${YEAR}-12-31T00:00:00+10:00`,
        unit_first_seen: `${CHANGEOVER}T00:00:00+10:00`,
        commencement_date: `${YEAR}-04-30T00:00:00+10:00`,
        commencement_date_specificity: 'month',
      }),
      ...['PLAYFB1', 'PLAYFB2', 'PLAYFB3', 'PLAYFB4'].map((code) =>
        unitRecord({
          facility_code: 'PLAYF',
          facility_name: 'Playford B',
          facility_region: 'SA1',
          unit_code: code,
          unit_capacity: 60,
          unit_status: 'retired',
          unit_last_seen: `${CHANGEOVER}T00:00:00+10:00`,
          commencement_date: '1962-12-31T00:00:00+10:00',
          commencement_date_specificity: 'year',
        })
      ),
    ]);

  it('emits one station row and never a superseded member', async () => {
    getFacilities.mockResolvedValue(playford());
    getFacilityData.mockResolvedValue({ datatable: { getRows: () => [] } });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const duids = full.data.map((u) => u.duid);

    expect(duids).toEqual(['PLAYB-AG']);
    // A 240 MW station must not be drawn as 480 MW of rows.
    expect(full.data[0].capacity).toBe(240);
    // ...and it has existed since 1963, not since the aggregate was registered.
    expect(full.data[0].commenced).toBe('1962-12-31');
  });

  it('never synthesises red zeros for a member after its metering moved', async () => {
    // Members report to the changeover, the aggregate from it — the shape of the
    // real handover. Before this fix the four member rows were filled with the
    // retired-unit 0 for the rest of the record.
    getFacilities.mockResolvedValue(playford());
    getFacilityData.mockResolvedValue({
      datatable: {
        getRows: () => [
          ...rowsForRange('PLAYFB2', 'NEM', `${YEAR}-01-01`, `${YEAR}-05-25`),
          ...rowsForRange('PLAYFB4', 'NEM', `${YEAR}-01-01`, `${YEAR}-05-25`),
          ...rowsForRange('PLAYB-AG', 'NEM', CHANGEOVER, `${YEAR}-12-31`),
        ],
      },
    });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'PLAYB-AG')!.history.data;

    // Before the handover the row carries the members' combined output:
    // 2 x 1200 MWh/day over 24 h is 100 MW, or 41.667% of the 240 MW station.
    expect(data[dayIndex(`${YEAR}-03-01`)]).toBeCloseTo(41.667, 2);
    // After it, the aggregate's own: 1200 MWh/day on 240 MW is 20.833%.
    expect(data[dayIndex(`${YEAR}-08-01`)]).toBeCloseTo(20.833, 2);
    // The members' silence from the handover on must never become a red 0.
    expect(data.slice(dayIndex(CHANGEOVER)).every((v) => v !== 0)).toBe(true);
  });

  it('sums both sides of the changeover day rather than dropping one', async () => {
    // The 5-minute data shows the member DUIDs stop at 05:45 and the aggregate
    // starts at 10:20 — disjoint, so the day's energy is the sum of the two.
    getFacilities.mockResolvedValue(playford());
    getFacilityData.mockResolvedValue({
      datatable: {
        getRows: () => [
          ...rowsForRange('PLAYFB2', 'NEM', CHANGEOVER, CHANGEOVER), // 1200 MWh
          ...rowsForRange('PLAYB-AG', 'NEM', CHANGEOVER, CHANGEOVER), // 1200 MWh
        ],
      },
    });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'PLAYB-AG')!.history.data;

    // 2400 MWh over 24 h on 240 MW → 41.667%, not the 20.833% of either alone.
    expect(data[dayIndex(CHANGEOVER)]).toBeCloseTo(41.667, 2);
  });
});

describe('pre-commissioning zeros', () => {
  // Millmerran 1: the DUID is registered on 2001-05-15 and reports a real 0
  // every day until the machine can generate. OpenElectricity's own
  // commencement_date is 178 days later.
  const COMMENCED = `${YEAR}-06-01`;

  const millmerran = (specificity: string) =>
    facilitiesEnvelope([
      unitRecord({
        facility_code: 'MILLMERN',
        facility_name: 'Millmerran',
        facility_region: 'QLD1',
        unit_code: 'MPP_1',
        unit_capacity: 426,
        unit_status: 'operating',
        commencement_date: `${COMMENCED}T00:00:00+10:00`,
        commencement_date_specificity: specificity,
      }),
    ]);

  /** Daily rows of exactly `energy` MWh across an inclusive range. */
  const zeroRows = (start: string, end: string): unknown[] =>
    (rowsForRange('MPP_1', 'NEM', start, end) as { energy: number }[]).map((r) => ({
      ...r,
      energy: 0,
    }));

  it('reads a zero before a day-precise commencement date as "not yet built"', async () => {
    getFacilities.mockResolvedValue(millmerran('day'));
    getFacilityData.mockResolvedValue({
      datatable: {
        getRows: () => [
          ...zeroRows(`${YEAR}-01-01`, `${YEAR}-05-31`),
          ...rowsForRange('MPP_1', 'NEM', COMMENCED, `${YEAR}-12-31`),
        ],
      },
    });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'MPP_1')!.history.data;

    expect(data[dayIndex(`${YEAR}-03-01`)]).toBeNull(); // pre-commission, not red
    expect(data[dayIndex(COMMENCED)]).not.toBeNull(); // real output from day one
  });

  it('leaves the zeros alone when the commencement date is only known to a month', async () => {
    // A coarse date would blank real generation at the edges, so it is ignored.
    getFacilities.mockResolvedValue(millmerran('month'));
    getFacilityData.mockResolvedValue({
      datatable: { getRows: () => zeroRows(`${YEAR}-01-01`, `${YEAR}-05-31`) },
    });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'MPP_1')!.history.data;

    expect(data[dayIndex(`${YEAR}-03-01`)]).toBe(0);
  });

  it('never discards a NON-zero reading, however early it looks', async () => {
    // The guard that keeps this a display rule rather than a data deletion: if
    // OpenElectricity ever reports real generation before its own commencement
    // date, the generation wins.
    getFacilities.mockResolvedValue(millmerran('day'));
    getFacilityData.mockResolvedValue({
      datatable: {
        getRows: () => rowsForRange('MPP_1', 'NEM', `${YEAR}-03-01`, `${YEAR}-03-01`),
      },
    });

    const service = new CapFacDataService('key');
    const full = await service.getCapacityFactors(YEAR, 'full');
    const data = full.data.find((u) => u.duid === 'MPP_1')!.history.data;

    expect(data[dayIndex(`${YEAR}-03-01`)]).toBeCloseTo(11.737, 2); // 1200 MWh on 426 MW
  });
});
