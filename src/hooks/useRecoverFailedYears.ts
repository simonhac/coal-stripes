import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startFailedYearRecovery } from '@/client/failed-year-recovery';

/**
 * Mount once, near the top of the page. Retries year queries that have
 * exhausted TanStack's retries, so a tile that failed to a pale-blue block
 * heals itself instead of waiting for a manual reload. All the behaviour — and
 * the reasoning — lives in `failed-year-recovery`.
 */
export function useRecoverFailedYears(): void {
  const queryClient = useQueryClient();

  useEffect(() => startFailedYearRecovery(queryClient), [queryClient]);
}
