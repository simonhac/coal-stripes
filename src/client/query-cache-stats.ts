import { QueryClient } from '@tanstack/react-query';
import { CapFacYear } from './cap-fac-year';
import { YearPayload } from './year-queries';

/**
 * Snapshot of the year-data query cache for the performance overlay.
 *
 * Two query families back a year, and the byte total has to respect that:
 * `capFacYear` holds one built view per (mode, year) — canvases, the expensive
 * part — while `capFacYearData` holds one payload per year, shared by both
 * views. So canvases are summed per view and JSON only once, which is why this
 * doesn't just add up a single per-entry total.
 *
 * Retry counts come from each query's fetchFailureCount.
 */
export interface YearCacheStats {
  numItems: number;
  totalKB: number;
  labels: string[];
  activeRequestsWithRetries: { label: string; retryCount: number }[];
}

/**
 * `2015f` / `2015c` — a cached view, as year then fleet-mode initial.
 *
 * The build id is deliberately absent: it is part of the query key, but it is
 * the same for every entry in a session, so showing it only made each chip
 * three times wider. Year first so the sort below groups by year rather than
 * splitting the list into a `current` half and a `full` half.
 */
function viewLabel(mode: string, year: number): string {
  return `${year}${mode === 'current' ? 'c' : 'f'}`;
}

export function getYearCacheStats(queryClient: QueryClient): YearCacheStats {
  const cache = queryClient.getQueryCache();

  const labels: string[] = [];
  const activeRequestsWithRetries: { label: string; retryCount: number }[] = [];
  let totalBytes = 0;

  // Built views: key is ['capFacYear', mode, year, BUILD_ID].
  for (const query of cache.findAll({ queryKey: ['capFacYear'] })) {
    const [, mode, year] = query.queryKey as [string, string, number, string];
    const label = viewLabel(mode, year);
    const data = query.state.data as CapFacYear | undefined;

    if (data) {
      labels.push(label);
      totalBytes += data.canvasSizeBytes;
    }

    if (query.state.fetchStatus === 'fetching') {
      activeRequestsWithRetries.push({ label, retryCount: query.state.fetchFailureCount });
    }
  }

  // Shared payloads: key is ['capFacYearData', year, BUILD_ID]. Counted for
  // bytes but not listed as chips — a payload is an implementation detail of
  // the views above, and listing it would double the length of the list.
  for (const query of cache.findAll({ queryKey: ['capFacYearData'] })) {
    const payload = query.state.data as YearPayload | undefined;
    if (payload) totalBytes += payload.sizeBytes;
  }

  labels.sort();

  return {
    numItems: labels.length,
    totalKB: totalBytes / 1024,
    labels,
    activeRequestsWithRetries,
  };
}
