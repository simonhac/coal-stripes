import { QueryClient } from '@tanstack/react-query';
import { CapFacYear } from './cap-fac-year';

/**
 * Snapshot of the year-data query cache for the performance overlay.
 * Byte totals come from CapFacYear.totalSizeBytes (JSON + canvas memory);
 * retry counts come from each query's fetchFailureCount.
 */
export interface YearCacheStats {
  numItems: number;
  totalKB: number;
  labels: string[];
  activeRequestsWithRetries: { label: string; retryCount: number }[];
}

export function getYearCacheStats(queryClient: QueryClient): YearCacheStats {
  const queries = queryClient.getQueryCache().findAll({ queryKey: ['capFacYear'] });

  const labels: string[] = [];
  const activeRequestsWithRetries: { label: string; retryCount: number }[] = [];
  let totalBytes = 0;

  for (const query of queries) {
    // Key is ['capFacYear', mode, year] — join the (mode, year) tail so each
    // cached entry gets a unique label (queryKey[1] alone is just the fleet
    // mode, which collapses every year to the same 'full'/'current' string).
    const label = query.queryKey.slice(1).join(':');
    const data = query.state.data as CapFacYear | undefined;

    if (data) {
      labels.push(label);
      totalBytes += data.totalSizeBytes;
    }

    if (query.state.fetchStatus === 'fetching') {
      activeRequestsWithRetries.push({ label, retryCount: query.state.fetchFailureCount });
    }
  }

  labels.sort();

  return {
    numItems: labels.length,
    totalKB: totalBytes / 1024,
    labels,
    activeRequestsWithRetries,
  };
}
