import { fromDate, toZoned, CalendarDate, parseDate, today } from '@internationalized/date';

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
 * Parse a date string from AEST time format
 * Accepts three formats:
 * 1. "YYYY-MM-DD" - plain date format
 * 2. "YYYY-MM-DDTHH:mm:ss+10:00" - full AEST datetime format
 * 3. "YYYY-MM-DDTHH:mm:ss.sssZ" or "YYYY-MM-DDTHH:mm:ssZ" - UTC format (converts to Brisbane time)
 * 
 * @param dateStr The date string to parse
 * @returns CalendarDate object
 * @throws Error if the string doesn't match one of the expected formats
 */
export function parseAESTDateString(dateStr: string): CalendarDate {
  // Check for plain date format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return parseDate(dateStr);
  }
  
  // Check for AEST datetime format: YYYY-MM-DDTHH:mm:ss+10:00
  const aestMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\+10:00$/);
  if (aestMatch) {
    return parseDate(aestMatch[1]);
  }
  
  // Check for UTC format: YYYY-MM-DDTHH:mm:ss.sssZ or YYYY-MM-DDTHH:mm:ssZ
  const utcMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}(?:\.\d{3})?Z$/);
  if (utcMatch) {
    const datePart = utcMatch[1];
    const hour = parseInt(utcMatch[2], 10);
    
    // UTC times from 14:00 onwards are the next day in Brisbane (UTC+10)
    // 14:00 UTC = 00:00 Brisbane next day
    const date = parseDate(datePart);
    return hour >= 14 ? date.add({ days: 1 }) : date;
  }
  
  // None of the formats matched
  throw new Error(
    `Invalid date format: "${dateStr}". Expected either "YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss+10:00", or "YYYY-MM-DDTHH:mm:ss[.sss]Z"`
  );
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
