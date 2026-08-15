/**
 * When each year is due to be rewritten — the arithmetic half of the refresher,
 * with no R2 in it so it can be tested directly.
 *
 * The windows still come from YEAR_CACHE_TIERS: one definition serves both the
 * response's `s-maxage` and this write schedule. What lives here is *phase* —
 * where inside its window each year falls — which is a server-only concern and
 * has no business in the shared config the client reads.
 *
 * Two problems this fixes, both observed on the live deployment on 2026-08-09:
 *
 *   1. Dueness used to be "age >= window", measured from the last write. That
 *      makes the schedule a function of when the previous build happened, so a
 *      cold bucket stamps every year at the same instant and they stay locked
 *      together forever after — 2006, 2019, 2021 and 2025 were all built within
 *      26 seconds of each other. Slot boundaries are absolute instead: a year is
 *      due when its `builtAt` falls in an earlier slot than now, so the schedule
 *      depends only on the year, never on the history of the bucket.
 *
 *   2. The current year drifted on whatever phase its last write left. Its whole
 *      job is to pick up the new day, and the DTO only gains one at Brisbane
 *      midnight (today and the future are null — see cap-fac-data-service). A
 *      payload built at 23:30 therefore ended at the day before yesterday for
 *      the next hour. Hour-aligned slots fix this for free: Brisbane is UTC+10
 *      with no DST, so every Brisbane midnight IS an hour boundary, and the
 *      first tick after midnight rebuilds.
 */
import { yearCachePolicy, type YearCacheTier } from '@/shared/config';
import type { ZonedDateTime } from '@internationalized/date';

/**
 * Brisbane is UTC+10 all year — the NEM's reference zone precisely because it
 * has no daylight saving — so the offset is a constant, not a lookup. Slot
 * grids are anchored to it rather than to the Unix epoch, which lands at 10:00
 * Brisbane and would put the daily boundary in the middle of a business day.
 */
const BRISBANE_OFFSET_SECONDS = 10 * 60 * 60;

/**
 * How many evenly spaced slots each tier's window is divided into, i.e. how many
 * distinct instants years of that tier can be rebuilt at.
 *
 * Chosen to match the size of each tier, so a year's slot is simply
 * `year % slots` — and because tiers are runs of *consecutive* years, that
 * spreads them perfectly evenly with no hashing. `recent` is exactly five years
 * over five slots, so one is rebuilt every 4.8 hours. `archive` is twenty-three
 * years over seven daily slots, so three or four are rebuilt each day instead of
 * all twenty-three in one tick.
 *
 * `current` gets a single slot deliberately: phase 0 puts it on the hour, and
 * therefore on Brisbane midnight, which is the only moment it gains new data.
 */
const TIER_SLOTS: Record<YearCacheTier, number> = {
  current: 1,
  recent: 5,
  archive: 7,
};

/** How far into its window a year's rebuild sits, in seconds. */
export function refreshPhaseSeconds(
  year: number,
  tier: YearCacheTier,
  windowSeconds: number,
): number {
  const slots = TIER_SLOTS[tier];
  return (year % slots) * (windowSeconds / slots);
}

/**
 * Which slot an instant falls in. Slot boundaries repeat every `windowSeconds`,
 * offset by `phaseSeconds` from Brisbane midnight.
 */
function slotIndex(instant: ZonedDateTime, windowSeconds: number, phaseSeconds: number): number {
  // toDate() is the library's own interop for absolute time — there is no way to
  // get an instant out of a ZonedDateTime without dropping to epoch millis.
  const epochSeconds = instant.toDate().getTime() / 1000;
  return Math.floor((epochSeconds + BRISBANE_OFFSET_SECONDS - phaseSeconds) / windowSeconds);
}

/**
 * Whether a year built at `builtAt` is due for a rewrite at `reference`.
 *
 * A null `builtAt` means nothing is stored, or the stamp could not be read — an
 * object written before this scheme, or by something else. Rewriting is the
 * cheap way to make it conform.
 *
 * Because dueness compares slots rather than elapsed time, a year is rebuilt
 * exactly once per window, and never more than one window goes by without one.
 * An off-schedule build — a visitor filling a cold year — simply lands in the
 * current slot and pushes the next rebuild to the next boundary.
 */
export function yearIsDueAt(
  year: number,
  currentYear: number,
  builtAt: ZonedDateTime | null,
  reference: ZonedDateTime,
): boolean {
  if (!builtAt) return true;

  const { tier, revalidateSeconds } = yearCachePolicy(year, currentYear);
  const phase = refreshPhaseSeconds(year, tier, revalidateSeconds);

  return (
    slotIndex(reference, revalidateSeconds, phase) >
    slotIndex(builtAt, revalidateSeconds, phase)
  );
}

/**
 * How far past its window a year has drifted, as a multiple of that window.
 * 1 means "exactly due"; anything much above 1 means earlier ticks are failing,
 * since a healthy sweep rebuilds within one cron interval of the boundary.
 */
export function windowsOverdue(
  year: number,
  currentYear: number,
  ageSeconds: number,
): number {
  return ageSeconds / yearCachePolicy(year, currentYear).revalidateSeconds;
}

/**
 * How far past its window a year may drift before we say so.
 *
 * A healthy sweep rebuilds within one cron interval of a slot boundary, so
 * anything at twice its window has been failing for a while — an expired API
 * key, an upstream outage, a budget that keeps running out. Shared by the
 * refresher's log line and the cache-management page's `stale` flag, so the two
 * can't disagree about what stale means.
 */
export const STALE_WINDOW_MULTIPLE = 2;
