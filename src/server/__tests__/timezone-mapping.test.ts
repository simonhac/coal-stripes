import { CapFacDataService } from '@/server/cap-fac-data-service';
import { parseDate } from '@internationalized/date';
import { setupTestLogger, cleanupTestLogger } from '../test-helpers';

beforeAll(() => {
  setupTestLogger();
});

afterAll(() => {
  cleanupTestLogger();
});

// The OpenElectricity client returns each daily bucket as the instant of
// network-local midnight. For the NEM (fixed AEST, UTC+10) the day D arrives as
// `${D}T00:00:00+10:00`. These tests exercise the private mapping directly to
// guard against off-by-one errors. All dates are in 2025 — comfortably in the
// past — so none are nulled as "today/future".
const nemMidnight = (day: string) => new Date(`${day}T00:00:00+10:00`);

const mockFacilities = [
  {
    facility_code: 'TEST',
    facility_name: 'Test Facility',
    facility_network: 'NEM',
    facility_region: 'NSW1',
    units: [{ unit_code: 'TEST01', unit_fueltech: 'coal_black', unit_capacity: 100 }],
  },
];

function process(mockData: unknown[], start: string, end: string) {
  const service = new CapFacDataService('dummy-key');
  return (service as any).processGeneratingUnitCapFacHistoryDTO(
    mockData,
    mockFacilities,
    parseDate(start),
    parseDate(end),
    'current'
  );
}

describe('Timezone Date Mapping', () => {
  it('maps AEST-midnight instants to the correct Brisbane day', () => {
    const mockData = [
      { interval: nemMidnight('2025-07-01'), unit_code: 'TEST01', energy: 1000 },
      { interval: nemMidnight('2025-07-02'), unit_code: 'TEST01', energy: 2000 },
    ];

    const unit = process(mockData, '2025-07-01', '2025-07-02').data[0];
    expect(unit.history.data[0]).toBe(41.7); // July 1 — 1000 MWh / 24 / 100 * 100
    expect(unit.history.data[1]).toBe(83.3); // July 2 — 2000 MWh
  });

  it('has no off-by-one errors across a complete week', () => {
    const mockData = [];
    for (let i = 1; i <= 7; i++) {
      mockData.push({
        interval: nemMidnight(`2025-07-0${i}`),
        unit_code: 'TEST01',
        energy: i * 100, // unique values to track the mapping
      });
    }

    const unit = process(mockData, '2025-07-01', '2025-07-07').data[0];
    expect(unit.history.data[0]).toBe(4.2); // July 1 — 100/24/100*100
    expect(unit.history.data[1]).toBe(8.3); // July 2
    expect(unit.history.data[2]).toBe(12.5); // July 3
    expect(unit.history.data[3]).toBe(16.7); // July 4
    expect(unit.history.data[4]).toBe(20.8); // July 5
    expect(unit.history.data[5]).toBe(25); // July 6
    expect(unit.history.data[6]).toBe(29.2); // July 7
  });

  it('maps an instant on the UTC day boundary to the correct network day', () => {
    // 2025-07-01T14:00:00Z is 00:00 AEST on July 2 — must land on July 2.
    const mockData = [
      { interval: new Date('2025-07-01T14:00:00.000Z'), unit_code: 'TEST01', energy: 1000 },
    ];

    const unit = process(mockData, '2025-07-02', '2025-07-02').data[0];
    expect(unit.history.data[0]).toBe(41.7); // July 2
  });
});
