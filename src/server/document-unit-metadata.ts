/**
 * The unit metadata as the SSR document needs it: cheap, and per isolate.
 *
 * @/routes/__root reads this once per document render. Workers Cache answers
 * most document requests without the Worker running at all, but every miss —
 * and there is at least one per colo per hour, plus every miss after a purge —
 * would otherwise pay an R2 read before a byte of HTML could be streamed.
 *
 * A short in-isolate memo removes that. Sixty seconds is chosen against what it
 * bounds: the document itself is cached for an hour (`s-maxage=3600`), so this
 * adds at most a sixtieth of the staleness a reader is already exposed to, and
 * for a fleet that changes a few times a year that is nothing.
 *
 * The promise is memoised rather than the value, so concurrent renders on a cold
 * isolate share one read instead of racing several.
 *
 * On a miss it falls back to the roster-only build, which is one memoised
 * facilities call and no year reads. It does NOT fall back to the full build:
 * that scans years, and on a cold store those years are not there either, so it
 * would sit on several OpenElectricity fetches and blow the request ceiling — on
 * every document, until one of them finished. The fallback costs about a second
 * and gives the visitor a complete chart; all it lacks is where each region's
 * record begins, which the next cron tick supplies. See rosterOnlyUnitMetadata.
 *
 * A failure is not memoised: a transient R2 error should cost one document its
 * metadata, not every document for the next minute.
 */
import { readStoredUnitMetadata, rosterOnlyUnitMetadata } from '@/server/year-store';
import type { UnitMetadataDTO } from '@/shared/types';

const MEMO_TTL_MS = 60_000;

let memo: Promise<UnitMetadataDTO | null> | null = null;
let memoAt = 0;

async function read(): Promise<UnitMetadataDTO | null> {
  const stored = await readStoredUnitMetadata();
  if (stored) return stored;

  try {
    const roster = await rosterOnlyUnitMetadata();
    console.warn(JSON.stringify({
      log: 'unit-metadata:roster-only',
      units: Object.keys(roster.unitsByDuid).length,
      note: 'nothing stored; serving the roster without region first-data days',
    }));
    return roster;
  } catch (error) {
    console.error(JSON.stringify({
      log: 'unit-metadata:roster-only-failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

export async function readDocumentUnitMetadata(): Promise<UnitMetadataDTO | null> {
  if (memo && Date.now() - memoAt < MEMO_TTL_MS) return memo;

  memoAt = Date.now();
  memo = read();

  const dto = await memo;
  if (!dto) memo = null;
  return dto;
}

/** Drop the memo, so the next document render re-reads. Used by the purge route. */
export function clearDocumentUnitMetadataMemo(): void {
  memo = null;
  memoAt = 0;
}
