/**
 * A reload's memory of the page's shape.
 *
 * The roster — which regions exist, which facilities they hold, and how tall
 * each facility's row is — is derived from a year of capacity-factor data, so
 * nothing about the page's layout could be drawn until ~360 KB of JSON had been
 * fetched, parsed, filtered and rasterised. That is why every refresh flashed
 * "Loading stripes…" over the whole page.
 *
 * None of that shape actually changes between one visit and the next: units are
 * commissioned and retired on a timescale of years. So it is cached here, and a
 * returning visitor gets the real page — header, region headers, facility
 * labels, correctly-sized rows — on the first frame, with the stripes themselves
 * shimmering in behind (see CompositeTile's `pendingData` state).
 *
 * This is a *layout* cache, never a data cache: it holds no capacity factors,
 * and the rows it sizes are drawn from the query cache exactly as before. If it
 * is absent, stale or wrong, the page is at worst as slow as it used to be —
 * every successful load rewrites it.
 *
 * Stored per fleet mode, because the two views genuinely differ (`full` carries
 * retired plants and SA1), and stamped with CF_DTO_VERSION so a payload-shape
 * change invalidates it the same way it invalidates the query keys.
 */

import { CF_DTO_VERSION } from '@/shared/config';
import type { FleetMode } from '@/shared/types';

/** One row of the page: a facility, and the canvas height its stripes need. */
export interface RosterFacility {
  code: string;
  name: string;
  /**
   * The tile canvas height in pixels — the sum of the facility's unit rows (see
   * FacilityYearTile). Optional because a facility present in the DTO may have
   * no built tile; CompositeTile falls back to its own default in that case.
   */
  height?: number;
}

interface StoredSnapshot {
  dto: string;
  regions: { code: string; facilities: RosterFacility[] }[];
}

function keyFor(mode: FleetMode): string {
  return `roster-snapshot:${mode}`;
}

/**
 * Narrow an untrusted parse to the stored shape. Anything unexpected returns
 * null rather than throwing: a corrupt or superseded snapshot must degrade to
 * the old spinner, never to a broken page.
 */
function parseSnapshot(raw: string): Map<string, RosterFacility[]> | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;

  const snapshot = parsed as Partial<StoredSnapshot>;
  if (snapshot.dto !== CF_DTO_VERSION) return null;
  if (!Array.isArray(snapshot.regions)) return null;

  const roster = new Map<string, RosterFacility[]>();
  for (const region of snapshot.regions) {
    if (typeof region?.code !== 'string' || !Array.isArray(region.facilities)) return null;
    const facilities: RosterFacility[] = [];
    for (const facility of region.facilities) {
      if (typeof facility?.code !== 'string' || typeof facility.name !== 'string') return null;
      facilities.push({
        code: facility.code,
        name: facility.name,
        height: typeof facility.height === 'number' ? facility.height : undefined,
      });
    }
    if (facilities.length > 0) roster.set(region.code, facilities);
  }
  return roster.size > 0 ? roster : null;
}

/**
 * The roster this device last saw for `mode`, or null on a first visit, a
 * blocked/absent store, a DTO version bump, or anything malformed.
 *
 * Synchronous by design — an async store (IndexedDB) would resolve a frame or
 * two after hydration, which is exactly the flash this exists to remove.
 */
export function loadRosterSnapshot(mode: FleetMode): Map<string, RosterFacility[]> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage?.getItem(keyFor(mode));
    return raw ? parseSnapshot(raw) : null;
  } catch {
    // Storage blocked (private mode / disabled), or unparseable: fall back to
    // loading from scratch, which is the pre-snapshot behaviour.
    return null;
  }
}

/** Record the roster just built, for the next load to draw its shell from. */
export function saveRosterSnapshot(
  mode: FleetMode,
  roster: Map<string, RosterFacility[]>
): void {
  if (typeof window === 'undefined' || roster.size === 0) return;
  try {
    const snapshot: StoredSnapshot = {
      dto: CF_DTO_VERSION,
      regions: Array.from(roster.entries()).map(([code, facilities]) => ({
        code,
        facilities,
      })),
    };
    window.localStorage?.setItem(keyFor(mode), JSON.stringify(snapshot));
  } catch {
    /* private mode / quota exceeded — the page just loads the slow way next time */
  }
}
