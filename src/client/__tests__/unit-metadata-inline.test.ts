/**
 * The metadata's trip through the document.
 *
 * It is serialised into an inline `<script>` in the head and read back off a
 * global, so the two things worth pinning are that a hostile-looking string
 * cannot break out of the element, and that a version skew is refused rather
 * than silently mis-joined. See @/client/unit-metadata-inline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNIT_METADATA_GLOBAL,
  readInlineUnitMetadata,
  regionFirstDataDay,
  unitMetadataScript,
} from '../unit-metadata-inline';
import { CF_DTO_VERSION } from '@/shared/config';
import type { UnitMetadataDTO } from '@/shared/types';

const blob = (over: Partial<UnitMetadataDTO> = {}): UnitMetadataDTO => ({
  type: 'unit_metadata',
  version: CF_DTO_VERSION,
  created_at: '2026-08-18T00:01:13+10:00',
  data_type: 'energy',
  units: 'MW',
  regions: { NSW1: { firstDataDay: '1998-12-07' }, WEM: { firstDataDay: '2006-09-20' } },
  unitsByDuid: {},
  ...over,
});

/** Run the inline script the way the browser would, then read the global back. */
function evaluate(dto: UnitMetadataDTO): void {
  new Function('window', unitMetadataScript(dto))(globalThis);
}

const clearGlobal = () => {
  delete (globalThis as unknown as Record<string, unknown>)[UNIT_METADATA_GLOBAL];
};

describe('unitMetadataScript', () => {
  beforeEach(clearGlobal);
  afterEach(() => {
    clearGlobal();
    vi.restoreAllMocks();
  });

  it('round-trips through the global it assigns', () => {
    const dto = blob();
    evaluate(dto);

    expect(readInlineUnitMetadata(CF_DTO_VERSION)).toEqual(dto);
  });

  it('escapes < so a facility name cannot close the script element', () => {
    // Facility names come straight from OpenElectricity. An unescaped
    // `</script>` would end the element and the rest of the blob would be
    // parsed as markup.
    const dto = blob({
      unitsByDuid: {
        EVIL: {
          network: 'nem',
          region: 'NSW1',
          capacity: 1,
          facility_code: 'E',
          facility_name: '</script><img src=x onerror=alert(1)>',
          fueltech: 'coal_black',
          status: 'operating',
        },
      },
    });

    const source = unitMetadataScript(dto);
    expect(source).not.toContain('</script>');
    expect(source).toContain('\\u003c/script');

    // …and it still parses back to exactly the name that went in.
    evaluate(dto);
    expect(readInlineUnitMetadata(CF_DTO_VERSION)!.unitsByDuid.EVIL.facility_name).toBe(
      '</script><img src=x onerror=alert(1)>',
    );
  });

  it('is absent, not empty, when no document inlined one', () => {
    expect(readInlineUnitMetadata(CF_DTO_VERSION)).toBeNull();
  });

  it('refuses a blob from a different DTO version', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    evaluate(blob({ version: 'v2' }));

    // A document that outlived the deploy whose payloads it describes. Joining
    // across it would mis-key silently, which is worse than rendering nothing.
    expect(readInlineUnitMetadata(CF_DTO_VERSION)).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('regionFirstDataDay', () => {
  beforeEach(clearGlobal);
  afterEach(clearGlobal);

  it('reports where a region\'s record begins', () => {
    evaluate(blob());

    // WEM's coal series starts seven years after the NEM's — the fact that made
    // leadingBackgroundDays correct for a window reaching back into 2005.
    expect(regionFirstDataDay('WEM')?.toString()).toBe('2006-09-20');
  });

  it('answers null for a region the scan could not resolve', () => {
    evaluate(blob());

    // Absent rather than guessed: the caller falls back to the global boundary.
    expect(regionFirstDataDay('TAS1')).toBeNull();
  });
});
