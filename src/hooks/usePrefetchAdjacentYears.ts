import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { yearQueryOptions, isValidYear } from '@/client/year-queries';
import type { FleetMode } from '@/shared/types';

/**
 * Prefetch the years surrounding the visible date range so scrolling the
 * timeline rarely waits on the network. Mounted once (in the page), driven by
 * the settled navigation target — not the per-frame animated range — so it
 * fires once per navigation.
 *
 * prefetchQuery is a no-op when fresh data is already cached and dedupes with
 * any in-flight fetch for the same year; failures are swallowed — the year
 * will be fetched properly (with error surfacing) when actually needed.
 */
export function usePrefetchAdjacentYears(
  mode: FleetMode,
  startYear: number | null,
  endYear: number | null
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (startYear === null || endYear === null) return;

    for (const year of [startYear - 2, startYear - 1, endYear + 1, endYear + 2]) {
      if (isValidYear(year)) {
        void queryClient.prefetchQuery(yearQueryOptions(mode, year));
      }
    }
  }, [queryClient, mode, startYear, endYear]);
}
