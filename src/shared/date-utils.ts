import {
  fromDate,
  toZoned,
  toCalendarDate,
  CalendarDate,
  parseAbsolute,
  parseDate,
  today,
  now,
  type ZonedDateTime,
} from '@internationalized/date';

/**
 * Calculate the number of days between two CalendarDate objects
 * Uses JavaScript Date for efficient calculation
 * 
 * @param start The start date
 * @param end The end date
 * @returns Number of days between the dates (negative if end is before start)
 */
export function getDaysBetween(start: CalendarDate, end: CalendarDate): number {
  // Use UTC midnights so the difference is always an exact multiple of a day.
  // (Local `new Date(y, m, d)` would be an hour short across a DST boundary,
  //  and Math.floor would then drop a whole day — making this non-inverse with
  //  CalendarDate.add and landing boundary navigation 1 day off.)
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));
}

/**
 * Get the day index within a year (0-based)
 * January 1st is day 0, December 31st is day 364 (or 365 in leap years)
 * 
 * @param date The date to get the index for
 * @returns The 0-based day index within the year
 */
export function getDayIndex(date: CalendarDate): number {
  const year = date.year;
  const month = date.month;
  const day = date.day;
  
  // Days in each month (non-leap year)
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  
  // Adjust February for leap years
  if (isLeapYear(year)) {
    daysInMonth[1] = 29;
  }
  
  // Sum days in all previous months
  let dayIndex = 0;
  for (let i = 0; i < month - 1; i++) {
    dayIndex += daysInMonth[i];
  }
  
  // Add the current day (subtract 1 because we want 0-based index)
  dayIndex += day - 1;
  
  return dayIndex;
}

/**
 * Get a CalendarDate from a year and day index
 * Day 0 is January 1st, day 364 is December 31st (or day 365 in leap years)
 * 
 * @param year The year
 * @param index The 0-based day index within the year
 * @returns The CalendarDate for that day
 * @throws Error if index is out of range for the given year
 */
export function getDateFromIndex(year: number, index: number): CalendarDate {
  // Validate index
  const maxIndex = isLeapYear(year) ? 365 : 364;
  if (index < 0 || index > maxIndex) {
    throw new Error(`Day index ${index} is out of range for year ${year} (0-${maxIndex})`);
  }
  
  // Days in each month
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  
  // Adjust February for leap years
  if (isLeapYear(year)) {
    daysInMonth[1] = 29;
  }
  
  // Find which month this day falls in
  let remainingDays = index;
  let month = 1;
  
  for (let i = 0; i < 12; i++) {
    if (remainingDays < daysInMonth[i]) {
      month = i + 1;
      break;
    }
    remainingDays -= daysInMonth[i];
  }
  
  // remainingDays is 0-based, but day is 1-based
  const day = remainingDays + 1;
  
  return parseDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/**
 * Check if a year is a leap year
 * 
 * @param year The year to check
 * @returns true if the year is a leap year
 */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * IANA timezone for each electricity network's local "market" time. Both zones
 * are deliberately daylight-saving-free: the NEM settles in AEST (UTC+10) all
 * year, and the WEM in AWST (UTC+8). Using Brisbane / Perth (rather than a raw
 * offset) keeps this expressed in the same @internationalized/date vocabulary
 * as the rest of the codebase — see getTodayAEST().
 */
const NETWORK_TIME_ZONE: Record<string, string> = {
  NEM: 'Australia/Brisbane', // UTC+10, no daylight saving
  WEM: 'Australia/Perth', // UTC+08, no daylight saving
  AU: 'Australia/Brisbane',
};

/**
 * Resolve an OpenElectricity daily-interval instant to the calendar day it
 * represents in its network's local time.
 *
 * The API labels each daily bucket with the instant of network-local midnight
 * (e.g. NEM 2024-06-01 arrives as 2024-05-31T14:00:00Z — i.e. 00:00 AEST). We
 * convert that instant back into the network's own timezone and take the date,
 * so NEM and WEM are each bucketed against their own local day with no offset
 * guesswork. The OpenElectricity client returns these instants in a
 * machine-timezone-independent way, so this is stable wherever it runs.
 *
 * History: earlier client versions double-applied the offset in
 * createNetworkDate (adding the host's DST-varying getTimezoneOffset() on top of
 * the already-correct tz-aware ISO string), which shifted days around the AU DST
 * transition. Filed as opennem/openelectricity-typescript#7 and fixed in PR #8
 * (shipped in 0.9.1). This reprojection is correct regardless, so it needs no
 * change — the note is just a breadcrumb for that settled area.
 *
 * @param interval The interval timestamp returned by the API (a Date)
 * @param network  The network the data belongs to ("NEM", "WEM", …)
 * @returns The network-local calendar day
 */
export function networkDayFromInterval(interval: Date, network: string): CalendarDate {
  const zone = NETWORK_TIME_ZONE[network] ?? NETWORK_TIME_ZONE.NEM;
  return toCalendarDate(fromDate(interval, zone));
}

/**
 * Get a date/time in AEST timezone format without milliseconds
 * Format: YYYY-MM-DDTHH:mm:ss+10:00
 * 
 * @param date The date to convert (defaults to current time)
 * @returns ISO 8601 formatted string with AEST timezone offset
 */
export function getAESTDateTimeString(date: Date = new Date()): string {
  // fromDate should interpret the Date object as UTC
  const utcDateTime = fromDate(date, 'UTC');

  // Then convert to AEST (Brisbane doesn't observe DST)
  const aestTime = toZoned(utcDateTime, 'Australia/Brisbane');
  
  // Format manually to ensure we get the right format
  const year = aestTime.year;
  const month = String(aestTime.month).padStart(2, '0');
  const day = String(aestTime.day).padStart(2, '0');
  const hour = String(aestTime.hour).padStart(2, '0');
  const minute = String(aestTime.minute).padStart(2, '0');
  const second = String(aestTime.second).padStart(2, '0');
  
  // AEST is always +10:00
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+10:00`;
}

/**
 * Get today's date in AEST (Brisbane time)
 *
 * @returns CalendarDate object representing today in Australian Eastern Standard Time
 */
export function getTodayAEST(): CalendarDate {
  return today('Australia/Brisbane');
}

/**
 * Parse a timestamp produced by getAESTDateTimeString back into an instant.
 *
 * Returns null rather than throwing, so a missing or malformed value — say from
 * a payload cached before a field existed — degrades to "unknown" at the call
 * site instead of breaking the page.
 */
export function parseAESTDateTime(stamp: string): ZonedDateTime | null {
  try {
    return parseAbsolute(stamp, 'Australia/Brisbane');
  } catch {
    return null;
  }
}

/**
 * How long ago `stamp` was, in words: "just now", "12 minutes ago",
 * "3 hours ago", "7 days ago". Null when the stamp can't be parsed.
 *
 * Used to state the age of cached data on /stats and /diagnostics, where the
 * question is always "is this fresh enough to trust?" — a rounded, readable
 * answer serves that better than a raw timestamp, which is shown alongside.
 */
export function formatAgeFromAEST(
  stamp: string,
  reference: ZonedDateTime = now('Australia/Brisbane'),
): string | null {
  const when = parseAESTDateTime(stamp);
  if (!when) return null;

  // toDate() is the library's own interop for absolute comparison: there is no
  // way to subtract two instants without dropping to epoch milliseconds.
  const seconds = Math.round((reference.toDate().getTime() - when.toDate().getTime()) / 1000);
  if (seconds < 90) return 'just now';

  const plural = (n: number, unit: string): string =>
    `${n} ${unit}${n === 1 ? '' : 's'} ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return plural(minutes, 'minute');

  const hours = Math.round(minutes / 60);
  if (hours < 36) return plural(hours, 'hour');

  return plural(Math.round(hours / 24), 'day');
}

/** An exact elapsed duration, split across calendar units. */
export interface ElapsedParts {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
}

/**
 * How much time elapsed between two instants, split across calendar units —
 * exactly, with no "a month is 30 days" anywhere.
 *
 * @internationalized/date has no `since`/`until`, only arithmetic, but that is
 * the half that is hard to get right: `add({months: n})` already knows that
 * February is short, that leap years exist, and how to clamp the 31st into a
 * 30-day month. So rather than dividing by an average month, this *counts* in
 * the library's own calendar: propose a figure from the calendar fields, then
 * correct by one if it overshot.
 *
 * The same add-and-correct handles days, which makes the result right in a zone
 * with DST too — a 23-hour day is a whole day here, as it should be. Brisbane
 * has none, but a function that only works in one timezone is a trap for
 * whoever moves it.
 *
 * Hours and minutes below that are fixed-length by definition, so plain
 * division is exact.
 */
export function elapsedSince(
  from: ZonedDateTime,
  to: ZonedDateTime,
): ElapsedParts {
  // Whole months by calendar position, then one correction: adding this many
  // months lands in `to`'s own calendar month, so it can only ever be one too
  // many (when `to`'s day-of-month or time-of-day is earlier).
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (months > 0 && from.add({ months }).compare(to) > 0) months -= 1;

  const afterMonths = from.add({ months });

  // Whole days, proposed from elapsed milliseconds and corrected in the
  // calendar, so a DST-shortened or -lengthened day counts as one day.
  let days = Math.floor(
    (to.toDate().getTime() - afterMonths.toDate().getTime()) / 86_400_000,
  );
  if (days > 0 && afterMonths.add({ days }).compare(to) > 0) days -= 1;
  else if (afterMonths.add({ days: days + 1 }).compare(to) <= 0) days += 1;

  const remainderMs =
    to.toDate().getTime() - afterMonths.add({ days }).toDate().getTime();

  return {
    years: Math.floor(months / 12),
    months: months % 12,
    days,
    hours: Math.floor(remainderMs / 3_600_000),
    minutes: Math.floor((remainderMs % 3_600_000) / 60_000),
  };
}

/** Largest first, so the first non-zero one is the one to lead with. */
const AGE_UNITS: readonly [keyof ElapsedParts, string][] = [
  ['years', 'y'],
  ['months', 'mon'],
  ['days', 'd'],
  ['hours', 'h'],
  // `mon` above rather than `mo` so that `m` is unambiguously minutes — the two
  // shortest suffixes are the ones a reader scanning a column would confuse.
  ['minutes', 'm'],
];

/**
 * The same age, compact enough to sit in a table column: "54m ago",
 * "7d 4h ago", "2y 3mon ago". Null when the stamp can't be parsed.
 *
 * Two units at most, and the second is dropped when it is zero, so the width
 * stays near-constant down a column and rows can be compared by scanning rather
 * than reading. `formatAgeFromAEST` stays for prose, where "3 hours ago" reads
 * better than "3h ago".
 */
export function formatCompactAgeFromAEST(
  stamp: string,
  reference: ZonedDateTime = now('Australia/Brisbane'),
): string | null {
  const when = parseAESTDateTime(stamp);
  if (!when) return null;
  if (when.compare(reference) > 0) return 'just now';

  const parts = elapsedSince(when, reference);
  const index = AGE_UNITS.findIndex(([unit]) => parts[unit] > 0);
  if (index === -1) return 'just now';

  const [unit, suffix] = AGE_UNITS[index];
  const next = AGE_UNITS[index + 1];
  const remainder = next ? parts[next[0]] : 0;

  return remainder > 0
    ? `${parts[unit]}${suffix} ${remainder}${next![1]} ago`
    : `${parts[unit]}${suffix} ago`;
}

/**
 * Get the short month name (3 letters) for a CalendarDate
 *
 * @param date CalendarDate object
 * @returns Three-letter month abbreviation
 */
export function getMonthName(date: CalendarDate): string {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return monthNames[date.month - 1];
}

/**
 * Get the calendar quarter (1–4) a date falls in.
 *
 * @param date CalendarDate object
 * @returns 1 for Jan–Mar, 2 for Apr–Jun, 3 for Jul–Sep, 4 for Oct–Dec
 */
export function getQuarter(date: CalendarDate): number {
  return Math.floor((date.month - 1) / 3) + 1;
}
