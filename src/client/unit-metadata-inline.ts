/**
 * The unit metadata, carried in the document rather than fetched.
 *
 * Every year payload is now just DUIDs and daily values; the facts that say what
 * a DUID *is* — capacity, facility, region, lifecycle dates — are served once,
 * here, as an inline script in the head. See @/shared/unit-metadata for the join
 * and for why the payload is split this way at all.
 *
 * Inlined rather than fetched from an `/api/metadata` route, deliberately. The
 * blob is ~2.0 KB gzipped against a document of ~3.5 KB, so it roughly doubles
 * the document — against saving a whole round trip on a zone whose edge is in
 * Singapore (see docs/caching-and-diagnostics.md). At this size a second request
 * cannot win.
 *
 * Two things make that safe rather than merely cheap. The document is served
 * `max-age=0, s-maxage=3600`, so an inlined copy is at worst an hour stale — fine
 * for a fleet that changes a few times a year. And every document carries
 * DOCUMENT_TAG, so @/routes/api.admin.purge and @/server/deploy-purge can already
 * reach them; there was no new invalidation mechanism to invent.
 *
 * It is a plain global rather than router loader data because the consumer is not
 * a React component: @/client/year-queries joins the metadata onto a payload
 * inside a TanStack Query `queryFn`, which is ordinary module code. Same shape as
 * the tripwire in @/client/stale-document-tripwire — a string of classic script
 * inlined into the head, which also means React removing the element during
 * hydration is harmless: the assignment already happened at parse time.
 */

import { CalendarDate, parseDate } from '@internationalized/date';
import { CF_DTO_VERSION } from '@/shared/config';
import type { UnitMetadataDTO } from '@/shared/types';

/** Where the document parks the blob. */
export const UNIT_METADATA_GLOBAL = '__coalUnitMetadata';

/**
 * The blob as source to inline.
 *
 * `<` is escaped because the payload carries facility names straight from
 * OpenElectricity: without it a name containing `</script>` would close the
 * element, and the rest of the blob would be parsed as markup. The JSON unicode
 * escape denotes the very same character, so nothing downstream can tell the
 * difference — only the HTML parser can.
 */
export function unitMetadataScript(dto: UnitMetadataDTO): string {
  const json = JSON.stringify(dto).replace(/</g, '\\u003c');
  return `window.${UNIT_METADATA_GLOBAL}=${json};`;
}

/**
 * The blob the document inlined, or null if there isn't one.
 *
 * A version mismatch is treated as absent. It means a document outlived the
 * deploy whose payloads it describes, and joining a v3 year against a v2 blob
 * would silently mis-key rather than fail — the tripwire's whole lesson is that
 * a silent wrong answer is worse than a visible missing one.
 */
export function readInlineUnitMetadata(expectedVersion: string): UnitMetadataDTO | null {
  // `globalThis`, not `window`: the script writes `window.X`, and in a browser
  // the two are the same object — but this also has to be callable during SSR
  // and under the test runner, where `window` does not exist at all.
  const raw = (globalThis as unknown as Record<string, unknown>)[UNIT_METADATA_GLOBAL];
  if (!raw) return null;

  const dto = raw as UnitMetadataDTO;
  if (dto.version !== expectedVersion) {
    console.error(
      `[stripes] inlined unit metadata is version ${dto.version}, expected ` +
        `${expectedVersion}; ignoring it`,
    );
    return null;
  }

  return dto;
}

/**
 * The first day a region has any data, or null if the blob does not say.
 *
 * The fact `leadingBackgroundDays` used to infer. Inference could not tell "the
 * record starts here" from "this region has a year-long collection gap here" —
 * it only ever saw the one or two years that happened to be loaded — which is
 * why WEM's true start (2006-09-20, seven years after the NEM's) had to be
 * guessed at from whichever tile was on screen. The server derives it once by
 * scanning the stored years; see regionFirstDataDays in @/server/year-store.
 *
 * Memoised, because CompositeTile asks on every paint of every row: the global
 * is written by an inline script in the head, so it is set long before any
 * module code runs and can never change within a page's life. Null is the honest
 * answer for a region the scan could not resolve, and callers fall back to the
 * global record boundary.
 *
 * An answer is only memoised once a blob is actually present — otherwise the
 * first call on a document that has none would cache a null for the rest of the
 * page, which is wrong the moment the metadata *is* there.
 */
const regionStarts = new Map<string, CalendarDate | null>();

export function regionFirstDataDay(regionCode: string): CalendarDate | null {
  const memo = regionStarts.get(regionCode);
  if (memo !== undefined) return memo;

  const metadata = readInlineUnitMetadata(CF_DTO_VERSION);
  if (!metadata) return null;

  const day = metadata.regions[regionCode]?.firstDataDay;
  const parsed = day ? parseDate(day) : null;
  regionStarts.set(regionCode, parsed);
  return parsed;
}
