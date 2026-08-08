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
import { currentDataYear } from '@/server/data-years';
import { CF_DTO_VERSION, yearCachePolicy } from '@/shared/config';
import { parseAESTDateTime } from '@/shared/date-utils';
import type { CoalGenerationStatsDTO, GeneratingUnitCapFacHistoryDTO } from '@/shared/types';
import { now, type ZonedDateTime } from '@internationalized/date';

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

export async function putYear(year: number, dto: GeneratingUnitCapFacHistoryDTO): Promise<void> {
  const b = await bucket();
  if (!b || !isStorable(year)) return;
  await b.put(yearKey(year), bodyOf(dto), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { builtAt: dto.created_at },
  });
}

export async function putStats(dto: CoalGenerationStatsDTO): Promise<void> {
  const b = await bucket();
  if (!b) return;
  await b.put(statsKey(), bodyOf(dto), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { builtAt: dto.created_at },
  });
}

/**
 * Build a year from OpenElectricity and store it. The only path that reaches
 * upstream, and the only one that costs real CPU.
 */
export async function buildYear(year: number): Promise<GeneratingUnitCapFacHistoryDTO> {
  const dto = await getCapFacDataService().getCapacityFactors(year);
  await putYear(year, dto);
  return dto;
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
export async function readYear(year: number): Promise<GeneratingUnitCapFacHistoryDTO | null> {
  try {
    const stored = await getYear(year);
    if (stored) return (await stored.json()) as GeneratingUnitCapFacHistoryDTO;
    return await buildYear(year);
  } catch (error) {
    console.error(JSON.stringify({
      log: 'year-store:read-failed',
      year,
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

/**
 * Whether a year is due for a rewrite, per its freshness tier.
 *
 * A HEAD carries customMetadata without the body, so the refresher can check
 * all 28 years for a few hundred bytes of traffic. Keeping the answer in the
 * object itself means the refresher holds no state of its own — nothing to get
 * out of sync with what is actually stored.
 *
 * The tiers in YEAR_CACHE_TIERS were written as cache expiry windows; here they
 * are read as a write schedule. Same intent — how long before this year's
 * numbers might have moved — so they stay a single source of truth.
 */
export async function yearIsDue(
  year: number,
  reference: ZonedDateTime = now('Australia/Brisbane'),
): Promise<boolean> {
  const b = await bucket();
  if (!b || !isStorable(year)) return false;

  const head = await b.head(yearKey(year));
  if (!head) return true;

  const builtAt = head.customMetadata?.builtAt;
  const when = builtAt ? parseAESTDateTime(builtAt) : null;
  // An object with no parseable builtAt predates this scheme, or was written by
  // something else. Rewriting it is the cheap way to make it conform.
  if (!when) return true;

  // toDate() is the library's own interop for absolute comparison — there is no
  // way to subtract two instants without dropping to epoch milliseconds. Same
  // pattern as formatAgeFromAEST in @/shared/date-utils.
  const ageSeconds = (reference.toDate().getTime() - when.toDate().getTime()) / 1000;
  return ageSeconds >= yearCachePolicy(year, currentDataYear()).revalidateSeconds;
}
