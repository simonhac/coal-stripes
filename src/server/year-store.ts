/**
 * The R2 payload store — the floor of the read path.
 *
 * Every year's capacity-factor DTO and both stats payloads live here as JSON
 * objects. Nothing expires. A visitor who misses Workers Cache pays an R2 read
 * (milliseconds, in the same region) instead of an OpenElectricity fetch
 * (3-9 s, measured at 12.8 s on a cold deploy). That is the whole point: the
 * problem was never that the cache went cold, it was that a miss was expensive.
 *
 * Why R2 and not a cache warmer: Cloudflare documents that scheduled
 * invocations "always run without cache involvement", subrequests included, so
 * a cron cannot populate Workers Cache by any means (four were tried against
 * the live deployment; see docs/workers-behaviour-measured.md). Bindings are
 * not subject to that limitation, so a cron *can* write to R2.
 *
 * Objects are stored as the serialised response bytes rather than as parsed
 * values. The read path can then stream `object.body` straight into a Response
 * without ever parsing 180 KB of JSON, and `builtAt` rides in customMetadata
 * where the header can reach it without touching the body.
 */
import { getCapFacDataService } from '@/server/cap-fac-data-service';
import { allDataYears, currentDataYear } from '@/server/data-years';
import {
  STALE_WINDOW_MULTIPLE,
  windowsOverdue,
  yearIsDueAt,
} from '@/server/refresh-schedule';
import { CF_DTO_VERSION } from '@/shared/config';
import { getAESTDateTimeString, parseAESTDateTime } from '@/shared/date-utils';
import { mapPool } from '@/shared/map-pool';
import { regionKey } from '@/shared/unit-metadata';
import type {
  CoalGenerationStatsDTO,
  UnitMetadata,
  UnitMetadataDTO,
  YearCapFacHistoryDTO,
} from '@/shared/types';
import { now, parseDate, type ZonedDateTime } from '@internationalized/date';

/**
 * Keys are namespaced by DTO version, so bumping CF_DTO_VERSION gives the new
 * shape a fresh namespace rather than leaving payloads of the old shape sitting
 * under keys the new code will read. Old objects become unreachable instead of
 * wrong, and can be deleted at leisure.
 *
 * The layout is also deliberately servable as-is: if we ever put a custom
 * domain in front of the bucket, `v1/years/2024.json` is already a sensible
 * public URL.
 */
export function yearKey(year: number): string {
  return `${CF_DTO_VERSION}/years/${year}.json`;
}

export function statsKey(): string {
  return `${CF_DTO_VERSION}/stats.json`;
}

/**
 * The one metadata blob every year joins against — see @/shared/unit-metadata.
 *
 * A single object rather than one per year precisely because its contents do not
 * vary by year; that is the property the whole split rests on.
 */
export function metadataKey(): string {
  return `${CF_DTO_VERSION}/unit-metadata.json`;
}

/**
 * The bucket binding.
 *
 * Read lazily rather than at module scope: `env` is not populated when the
 * module graph is first evaluated in some contexts, and a module-level capture
 * would freeze an undefined binding for the isolate's lifetime.
 */
async function bucket(): Promise<R2Bucket | null> {
  const { env } = await import('cloudflare:workers');
  const binding = (env as unknown as { DATA?: R2Bucket })?.DATA;
  return binding ?? null;
}

/**
 * Future years are never stored. They have no data yet, and the route serves
 * them `no-store` (see cache-headers.ts) — persisting a payload of nulls would
 * mean serving it back for the rest of the year.
 */
function isStorable(year: number): boolean {
  return year <= currentDataYear();
}

function bodyOf(dto: unknown): string {
  return JSON.stringify(dto);
}

/**
 * A digest of everything in the payload except when it was built.
 *
 * Every rebuild produces a new `created_at`, so the bytes always differ and the
 * store cannot tell a genuine revision from a re-fetch of identical numbers.
 * That distinction is what decides whether to purge the edge and refold the
 * stats, and — over a few weeks of `dataChangedAt` stamps — whether the archive
 * tier's weekly rebuild is buying anything at all.
 *
 * Serialising twice is deliberate. Composing the body from a pre-serialised
 * `data` array would avoid it, but would silently drop any field later added to
 * the DTO; a second `JSON.stringify` is a few milliseconds against the 3-9 s
 * upstream fetch that preceded it.
 */
async function contentHash(dto: { created_at: string }): Promise<string> {
  const canonical = JSON.stringify({ ...dto, created_at: '' });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a write did, beyond succeeding. */
export interface StoreWrite {
  /** Whether the payload differs from the one it replaced, `created_at` aside. */
  changed: boolean;
  /** When the numbers last actually moved — carried forward across re-fetches. */
  dataChangedAt: string;
}

/** Shared by putYear and putStats: hash, compare, write, report. */
async function putPayload(
  b: R2Bucket,
  key: string,
  dto: { created_at: string },
): Promise<StoreWrite> {
  const hash = await contentHash(dto);
  const previous = await b.head(key);
  const changed = previous?.customMetadata?.contentHash !== hash;
  const dataChangedAt = changed
    ? dto.created_at
    : previous?.customMetadata?.dataChangedAt ?? dto.created_at;

  // Written even when nothing changed: R2 has no metadata-only update, and
  // `builtAt` must advance or the year stays due and is re-fetched every tick.
  await b.put(key, bodyOf(dto), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { builtAt: dto.created_at, contentHash: hash, dataChangedAt },
  });

  return { changed, dataChangedAt };
}

/** The stored object for a year, body unread so the caller can stream it. */
export async function getYear(year: number): Promise<R2ObjectBody | null> {
  const b = await bucket();
  if (!b) return null;
  return b.get(yearKey(year));
}

export async function getStats(): Promise<R2ObjectBody | null> {
  const b = await bucket();
  if (!b) return null;
  return b.get(statsKey());
}

export async function putYear(
  year: number,
  dto: YearCapFacHistoryDTO,
): Promise<StoreWrite> {
  const b = await bucket();
  // Nowhere to store it, so nothing changed for anyone downstream.
  if (!b || !isStorable(year)) return { changed: false, dataChangedAt: dto.created_at };
  return putPayload(b, yearKey(year), dto);
}

export async function putStats(dto: CoalGenerationStatsDTO): Promise<StoreWrite> {
  const b = await bucket();
  if (!b) return { changed: false, dataChangedAt: dto.created_at };
  return putPayload(b, statsKey(), dto);
}

/** A freshly built year, and what storing it did. */
export interface YearBuild extends StoreWrite {
  dto: YearCapFacHistoryDTO;
}

/**
 * Build a year from OpenElectricity and store it. The only path that reaches
 * upstream, and the only one that costs real CPU.
 */
export async function buildYear(year: number): Promise<YearBuild> {
  const dto = await getCapFacDataService().getCapacityFactors(year);
  const write = await putYear(year, dto);
  return { dto, ...write };
}

/**
 * A year's DTO, parsed, self-healing: R2 first, upstream and backfill on a
 * miss. Both the route and the stats service go through this, so a cold bucket
 * pays for a year exactly once, ever.
 *
 * Returns null when the year cannot be built at all — the stats service depends
 * on distinguishing "this year failed" from "this year is empty", and callers
 * must not read a null as a zero.
 */
export async function readYear(year: number): Promise<YearCapFacHistoryDTO | null> {
  try {
    const stored = await getYear(year);
    if (stored) return (await stored.json()) as YearCapFacHistoryDTO;
    return (await buildYear(year)).dto;
  } catch (error) {
    console.error(JSON.stringify({
      log: 'year-store:read-failed',
      year,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

// ============================================================================
// The unit metadata blob
// ============================================================================

/** The stored blob, body unread, for the route that streams it. */
export async function getUnitMetadataObject(): Promise<R2ObjectBody | null> {
  const b = await bucket();
  if (!b) return null;
  return b.get(metadataKey());
}

export async function putUnitMetadata(dto: UnitMetadataDTO): Promise<StoreWrite> {
  const b = await bucket();
  if (!b) return { changed: false, dataChangedAt: dto.created_at };
  return putPayload(b, metadataKey(), dto);
}

/**
 * Where each region's record begins, derived from the stored years.
 *
 * This is the fact that makes the leading edge of the chart a fact rather than
 * an inference: `leadingBackgroundDays` used to guess it from whichever one or
 * two years happened to be loaded, which cannot tell "the record starts here"
 * from "this region has a year-long collection gap here".
 *
 * It is derived from the actual daily values, never from `data_first_seen` —
 * that field reports the start of a unit's later contiguous run, so MM4 claims
 * 2000-02-28 when data exists from 1999-01-06, and a region minimum built from
 * it would be quietly late. See the note on EARLIEST_START_DATE in
 * @/shared/config.
 *
 * Cheap despite scanning whole years, because it walks them oldest-first and
 * stops the moment every region has an answer: the NEM regions all resolve on
 * the first year and WEM on 2006, so it is ~9 R2 reads. A region that never
 * reports is left OUT rather than given a guessed date — an absent key makes
 * the client fall back to the global boundary, which is the honest answer.
 */
async function regionFirstDataDays(
  unitsByDuid: Record<string, UnitMetadata>,
): Promise<Record<string, { firstDataDay: string }>> {
  const wanted = new Set(
    Object.values(unitsByDuid).map((u) => regionKey(u.network, u.region)),
  );
  const found: Record<string, { firstDataDay: string }> = {};
  const scanned: number[] = [];

  for (const year of allDataYears()) {
    if (wanted.size === 0) break;
    scanned.push(year);

    const dto = await readYear(year);
    if (!dto) continue;

    // Day index → date within this year, resolved from the payload's own window
    // rather than assumed to be 1 January: a year's `history.start` is the
    // contract, and reading it costs nothing.
    for (const unit of dto.data) {
      const meta = unitsByDuid[unit.duid];
      if (!meta) continue;
      const region = regionKey(meta.network, meta.region);
      if (!wanted.has(region)) continue;

      const values = unit.history.data;
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null) continue;
        const day = parseDate(unit.history.start).add({ days: i }).toString();
        const best = found[region];
        if (!best || day < best.firstDataDay) found[region] = { firstDataDay: day };
        break;
      }
    }

    for (const region of [...wanted]) {
      if (found[region]) wanted.delete(region);
    }
  }

  console.log(JSON.stringify({
    log: 'unit-metadata:region-scan',
    scanned,
    found: Object.fromEntries(
      Object.entries(found).map(([r, v]) => [r, v.firstDataDay]),
    ),
    unresolved: [...wanted],
  }));

  return found;
}

/** A freshly built metadata blob, and what storing it did. */
export interface UnitMetadataBuild extends StoreWrite {
  dto: UnitMetadataDTO;
}

/**
 * The roster half of the blob, with no region scan and nothing written.
 *
 * Everything needed to *render* a unit — capacity, facility, region, lifecycle
 * dates — from one memoised facilities call and no year reads at all. What it
 * lacks is `regions`, which costs the ascending scan above.
 *
 * That split exists so a cold store still serves a working page. The alternative
 * on a miss is no metadata, and no metadata means no rows: not a degraded chart,
 * an empty one. Missing region days are a far smaller thing — the leading edge
 * of a region that has not started yet falls back to the global record boundary,
 * so WEM shows pale blue rather than page background for a few years until the
 * next full build. Wrong in a corner, against wrong everywhere.
 *
 * Deliberately NOT stored: a partial blob in R2 would keep being served in
 * preference to a full one, and its hash would flip-flop against the full
 * build's, purging every SSR document on alternate ticks.
 */
export async function rosterOnlyUnitMetadata(): Promise<UnitMetadataDTO> {
  return {
    type: 'unit_metadata',
    version: CF_DTO_VERSION,
    created_at: getAESTDateTimeString(),
    data_type: 'energy',
    units: 'MW',
    regions: {},
    unitsByDuid: await getCapFacDataService().getUnitMetadata(),
  };
}

/**
 * Build the metadata blob and store it.
 *
 * Unlike `buildYear` this costs no energy query — just the memoised facilities
 * roster, plus the bounded region scan above. Run it AFTER the years in a sweep:
 * the region scan reads them back, so doing it first would date the answer by a
 * tick.
 */
export async function buildUnitMetadata(): Promise<UnitMetadataBuild> {
  const roster = await rosterOnlyUnitMetadata();
  const dto: UnitMetadataDTO = {
    ...roster,
    regions: await regionFirstDataDays(roster.unitsByDuid),
  };
  const write = await putUnitMetadata(dto);
  return { dto, ...write };
}

/**
 * The stored blob, parsed. Never builds — a miss is simply null.
 *
 * This is the variant the SSR document uses, and the distinction is the whole
 * reason there are two. Building the blob means scanning years, and on a cold
 * bucket those years are not there either, so a self-healing read from a
 * document render would sit on ~9 OpenElectricity fetches and blow the request
 * ceiling — on every document, until one of them finished. Returning null
 * instead renders a chart with no rows, which is honest, cheap, and fixed by the
 * next cron tick.
 */
export async function readStoredUnitMetadata(): Promise<UnitMetadataDTO | null> {
  try {
    const stored = await getUnitMetadataObject();
    return stored ? ((await stored.json()) as UnitMetadataDTO) : null;
  } catch (error) {
    console.error(JSON.stringify({
      log: 'unit-metadata:read-failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

/**
 * The metadata blob, parsed, self-healing: R2 first, build on a miss.
 *
 * For the paths that can afford to pay — the stats fold, which is already a
 * ~40 s job on a cold bucket, and the cron. NOT for the document; see above.
 *
 * Returns null only when it cannot be produced at all. Callers must NOT read
 * that as "no units": the fold throws on it rather than publishing zeros.
 */
export async function readUnitMetadata(): Promise<UnitMetadataDTO | null> {
  try {
    const stored = await readStoredUnitMetadata();
    if (stored) return stored;
    return (await buildUnitMetadata()).dto;
  } catch (error) {
    console.error(JSON.stringify({
      log: 'unit-metadata:build-failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

/** How long the stats payload may go unrebuilt. Matches its own `s-maxage`. */
const STATS_MAX_AGE_SECONDS = 60 * 60 * 24;

/**
 * Whether the stats payload needs rebuilding on age alone.
 *
 * The refresher's main trigger is "a year moved", but that is not sufficient by
 * itself: if a tick rewrites years and the fold then fails, every later tick
 * sees an unchanged set of years and would never retry, leaving the object
 * missing or stale until some visitor pays ~40 s to rebuild it. This is the
 * backstop for that.
 */
export async function statsIsDue(
  reference: ZonedDateTime = now('Australia/Brisbane'),
): Promise<boolean> {
  const b = await bucket();
  if (!b) return false;

  const head = await b.head(statsKey());
  if (!head) return true;

  const when = head.customMetadata?.builtAt
    ? parseAESTDateTime(head.customMetadata.builtAt)
    : null;
  if (!when) return true;

  const ageSeconds = (reference.toDate().getTime() - when.toDate().getTime()) / 1000;
  return ageSeconds >= STATS_MAX_AGE_SECONDS;
}

/** Whether a year needs rewriting, and how far past its window it already is. */
export interface YearFreshness {
  due: boolean;
  /** Seconds since builtAt; null when nothing is stored or the stamp is unreadable. */
  ageSeconds: number | null;
}

/**
 * Whether a year is due for a rewrite, per its freshness tier.
 *
 * A HEAD carries customMetadata without the body, so the refresher can check
 * all 29 years for a few hundred bytes of traffic. Keeping the answer in the
 * object itself means the refresher holds no state of its own — nothing to get
 * out of sync with what is actually stored.
 *
 * The tiers in YEAR_CACHE_TIERS were written as cache expiry windows; here they
 * are read as a write schedule. Same intent — how long before this year's
 * numbers might have moved — so they stay a single source of truth. Where in
 * each window a given year falls is decided by @/server/refresh-schedule.
 *
 * The age comes back with the answer because the caller wants it for a different
 * question — "has this drifted so far past its window that earlier ticks must be
 * failing?" — and re-reading the object to ask would double the sweep's traffic.
 */
export async function yearFreshness(
  year: number,
  reference: ZonedDateTime = now('Australia/Brisbane'),
): Promise<YearFreshness> {
  const b = await bucket();
  if (!b || !isStorable(year)) return { due: false, ageSeconds: null };

  const head = await b.head(yearKey(year));
  if (!head) return { due: true, ageSeconds: null };

  const builtAt = head.customMetadata?.builtAt;
  // An object with no parseable builtAt predates this scheme, or was written by
  // something else. Rewriting it is the cheap way to make it conform.
  const when = builtAt ? parseAESTDateTime(builtAt) : null;
  if (!when) return { due: true, ageSeconds: null };

  // toDate() is the library's own interop for absolute comparison — there is no
  // way to subtract two instants without dropping to epoch milliseconds. Same
  // pattern as formatAgeFromAEST in @/shared/date-utils.
  const ageSeconds = (reference.toDate().getTime() - when.toDate().getTime()) / 1000;
  return {
    due: yearIsDueAt(year, currentDataYear(), when, reference),
    ageSeconds,
  };
}

export async function yearIsDue(
  year: number,
  reference: ZonedDateTime = now('Australia/Brisbane'),
): Promise<boolean> {
  return (await yearFreshness(year, reference)).due;
}

/** One stored file, as reported to the cache-management page. */
export interface StoreEntry {
  /** `year` rows carry a year; the single `stats` and `metadata` rows do not. */
  kind: 'year' | 'stats' | 'metadata';
  year?: number;
  /** When we last fetched this from OpenElectricity. Null = never built. */
  builtAt: string | null;
  /** When its numbers last actually moved. */
  dataChangedAt: string | null;
  sizeBytes: number | null;
  /**
   * Past twice its freshness window, so earlier cron ticks must have been
   * failing. Always false for the stats and metadata rows, which have no
   * per-year tier.
   */
  stale: boolean;
}

/**
 * Everything in the store, in one sweep of HEADs.
 *
 * The point is that this costs a few hundred bytes rather than ~5 MB. A `head`
 * carries `customMetadata` without the body, which is how the refresher checks
 * all 29 years every ten minutes; the cache-management page wants the same
 * three stamps for the same price. Reading the payloads to answer "how old is
 * this?" — which is what probing every year used to do — downloads the entire
 * store to look at three strings.
 *
 * It lives here rather than in a route because `bucket()` is private to this
 * module, and it deliberately reports rather than judges: a missing object is a
 * null `builtAt`, not an error. An empty bucket is a legitimate state (a fresh
 * local `wrangler dev`), and the page should show it as one.
 */
export async function storeStatus(
  reference: ZonedDateTime = now('Australia/Brisbane'),
): Promise<StoreEntry[]> {
  const b = await bucket();
  const years = allDataYears();
  if (!b) {
    return [
      { kind: 'metadata', builtAt: null, dataChangedAt: null, sizeBytes: null, stale: false },
      ...years.map((year): StoreEntry => ({
        kind: 'year',
        year,
        builtAt: null,
        dataChangedAt: null,
        sizeBytes: null,
        stale: false,
      })),
      { kind: 'stats', builtAt: null, dataChangedAt: null, sizeBytes: null, stale: false },
    ];
  }

  // Bounded because 29 concurrent HEADs against one bucket is a stampede for no
  // gain; the same limit the refresher fans out with.
  const yearEntries = await mapPool(years, 5, async (year): Promise<StoreEntry> => {
    const head = await b.head(yearKey(year));
    const builtAt = head?.customMetadata?.builtAt ?? null;
    const when = builtAt ? parseAESTDateTime(builtAt) : null;
    const ageSeconds = when
      ? (reference.toDate().getTime() - when.toDate().getTime()) / 1000
      : null;

    return {
      kind: 'year',
      year,
      builtAt,
      dataChangedAt: head?.customMetadata?.dataChangedAt ?? null,
      sizeBytes: head?.size ?? null,
      // A future year is never stored, so its absence is correct rather than
      // alarming — see isStorable.
      stale:
        isStorable(year) &&
        (ageSeconds === null ||
          windowsOverdue(year, currentDataYear(), ageSeconds) >= STALE_WINDOW_MULTIPLE),
    };
  });

  // Metadata first: every year joins against it, so it is what a reader of the
  // table should check when the whole store looks wrong.
  const metadataHead = await b.head(metadataKey());
  const statsHead = await b.head(statsKey());
  return [
    {
      kind: 'metadata',
      builtAt: metadataHead?.customMetadata?.builtAt ?? null,
      dataChangedAt: metadataHead?.customMetadata?.dataChangedAt ?? null,
      sizeBytes: metadataHead?.size ?? null,
      stale: false,
    },
    ...yearEntries,
    {
      kind: 'stats',
      builtAt: statsHead?.customMetadata?.builtAt ?? null,
      dataChangedAt: statsHead?.customMetadata?.dataChangedAt ?? null,
      sizeBytes: statsHead?.size ?? null,
      stale: false,
    },
  ];
}
