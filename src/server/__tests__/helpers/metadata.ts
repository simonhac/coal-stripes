import { CF_DTO_VERSION } from '@/shared/config';
import type { UnitMetadata, UnitMetadataDTO } from '@/shared/types';

/**
 * A metadata blob for the DUIDs a test cares about.
 *
 * Year payloads carry only DUIDs and values, so any test that drives
 * `computeCoalStats` has to supply the other half — see @/shared/unit-metadata.
 * Everything not named falls back to a plausible NSW1 black-coal unit, because
 * the folds under test read `capacity`, `region`, `network` and `foldedInto` and
 * nothing else.
 */
export function makeUnitMetadata(
  units: Record<string, Partial<UnitMetadata>>,
): UnitMetadataDTO {
  return {
    type: 'unit_metadata',
    version: CF_DTO_VERSION,
    created_at: '2026-01-01T00:00:00+10:00',
    data_type: 'energy',
    units: 'MW',
    regions: {},
    unitsByDuid: Object.fromEntries(
      Object.entries(units).map(([duid, over]) => [
        duid,
        {
          network: 'nem',
          region: 'NSW1',
          capacity: 660,
          facility_code: 'FAC',
          facility_name: 'Facility',
          fueltech: 'coal_black',
          status: 'operating' as const,
          ...over,
        },
      ]),
    ),
  };
}
