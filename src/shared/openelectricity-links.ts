/**
 * Links out to Open Electricity's own site.
 *
 * Note the public site is `openelectricity.org.au`, not the
 * `explore.openelectricity.org.au` SPA — the latter returns 200 for every path,
 * so a bad code there lands on a blank page instead of a 404.
 */

/** Open Electricity's facility page, e.g. .../facility/BAYSW */
export function facilityUrl(facilityCode: string): string {
  return `https://openelectricity.org.au/facility/${encodeURIComponent(facilityCode)}`;
}
