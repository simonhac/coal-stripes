import { queryOptions } from '@tanstack/react-query';
import type { CoalGenerationStatsDTO } from '@/shared/types';

/**
 * The client's query for the coal-generation stats page. As everywhere else,
 * the browser talks only to our own /api/stats route (never OpenElectricity).
 *
 * The fetch uses `cache: 'no-store'` so the browser never serves a day-old body
 * from its own HTTP cache (the response is `max-age=86400` for the CDN): the
 * request still hits the CDN edge, which serves its current cached copy, so we
 * always get today's data in today's DTO shape — important because a stale body
 * from before a deploy could lack newly-added fields. TanStack Query still
 * dedupes and caches within the session via `staleTime`.
 */
export function statsQueryOptions() {
  return queryOptions({
    queryKey: ['coalStats'] as const,
    queryFn: async ({ signal }): Promise<CoalGenerationStatsDTO> => {
      const res = await fetch('/api/stats', { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    },
    staleTime: 60 * 60 * 1000, // 1 hour
  });
}
