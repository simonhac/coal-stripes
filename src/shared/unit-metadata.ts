/**
 * Joining a year's daily series back to the units they belong to.
 *
 * A year file holds only what is genuinely per-year: a DUID and its values (see
 * YearUnitDTO). Everything else about a unit — capacity, facility, region,
 * status, lifecycle dates — is year-independent and is served ONCE, inlined into
 * the SSR document, rather than repeated in all 29 year files. This module is
 * the one place the two halves are put back together, so the browser and the
 * server-side stats fold can never disagree about what a join means.
 *
 * Why the split is on *mutability* rather than on "metadata vs series": the
 * fields that moved include `last_seen`, which advances every day for every
 * operating unit. It rode in every year file, so the year 2000 payload changed
 * its bytes daily and the store marked a 26-year-old year as revised — purging
 * its edge copy — every single night. With it gone, a historical year hashes
 * identically from one rebuild to the next, which is the whole point.
 *
 * ---- What happens when the two disagree ----------------------------------
 *
 * The lifecycle fields degrade exactly as they always have: `lifecycleBounds` is
 * optional by construction and `aliveSpan` falls back to inferring a unit's span
 * from the values alone (both in @/shared/data-gaps), so a blob that lags on
 * `commenced`/`last_seen` costs nothing.
 *
 * Identity is different, and this is the one behaviour the split changed. A DUID
 * present in a year file but absent from the blob cannot be drawn at all — no
 * capacity means no row height, no facility_code means nothing to group it under
 * — so it is DROPPED, loudly, and every other unit renders normally. That beats
 * the alternatives: inventing a capacity would put a fictional row on the chart,
 * and failing the whole payload would blank the page over one unit.
 *
 * The window in which that can happen is the SSR document's `s-maxage` (an
 * hour): a visitor holding an hour-old document meets a freshly-built year file.
 * It takes a brand-new coal unit appearing upstream inside that hour. Deploys
 * are not a way in — @/server/deploy-purge flushes documents by DOCUMENT_TAG.
 */

import type {
  GeneratingUnitCapFacHistoryDTO,
  UnitMetadata,
  YearCapFacHistoryDTO,
} from './types';

/**
 * The region a unit belongs to, as every per-region map in the app keys it.
 *
 * WEM units are their own region: WEM and the NEM regions are separate data
 * feeds with different reporting spans. OpenElectricity already reports
 * `facility_region: 'WEM'` for them, so this is mostly a guard for the
 * (never-observed) case of a WEM facility with no region.
 */
export function regionKey(network: string, region?: string | null): string {
  if (region) return region;
  return network.toUpperCase() === 'WEM' ? 'WEM' : 'UNKNOWN';
}

/**
 * A year's payload with each unit's metadata joined back on.
 *
 * Returns the units in the year file's own order — which is the roster's display
 * order, set once in @/server/cap-fac-data-service and relied on by
 * buildFacilitiesByRegion.
 */
export function hydrateYear(
  dto: YearCapFacHistoryDTO,
  metadata: Record<string, UnitMetadata> | null | undefined,
): GeneratingUnitCapFacHistoryDTO {
  // Which year this is, for the messages below — a payload names its window but
  // not its year, and "the 2003 payload" is what a reader needs to hear.
  const year = dto.data[0]?.history.start.slice(0, 4) ?? 'unknown';

  if (!metadata) {
    console.warn(
      `[stripes] no unit metadata available, so none of the ${dto.data.length} ` +
        `units in the ${year} payload can be drawn`,
    );
    return { ...dto, data: [] };
  }

  const data = [];
  const unknown: string[] = [];
  for (const unit of dto.data) {
    const meta = metadata[unit.duid];
    if (!meta) {
      unknown.push(unit.duid);
      continue;
    }
    data.push({ ...meta, ...unit });
  }

  // One line, not one per unit: a metadata blob that has fallen behind a year
  // file misses whole units at a time, and 99 warnings say nothing 1 does not.
  if (unknown.length > 0) {
    console.warn(
      `[stripes] unit metadata is missing ${unknown.length} DUID(s) present in ` +
        `the ${year} payload; dropping them: ${unknown.join(', ')}`,
    );
  }

  return { ...dto, data };
}
