import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedFunction } from 'vitest';
import { CalendarDate } from '@internationalized/date';
import { QueryClient } from '@tanstack/react-query';
import * as dateUtils from '@/shared/date-utils';
import {
  getEarliestYear,
  getLatestYear,
  isValidYear,
  yearDataQueryOptions,
  yearQueryOptions,
} from '../year-queries';
import { CF_DTO_VERSION, YEAR_CACHE_TIERS } from '@/shared/config';

// Mock the date utilities so "today" is deterministic
vi.mock('@/shared/date-utils', async () => ({
  ...(await vi.importActual<typeof import('@/shared/date-utils')>('@/shared/date-utils')),
  getTodayAEST: vi.fn()
}));

const mockGetTodayAEST = dateUtils.getTodayAEST as MockedFunction<typeof dateUtils.getTodayAEST>;

describe('year-queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 7, 15));
  });

  describe('year bounds', () => {
    it('should return 1999 as the earliest year (start of facility-level data)', () => {
      expect(getEarliestYear()).toBe(1999);
    });

    it('should return the current year as the latest year', () => {
      expect(getLatestYear()).toBe(2024);
    });

    it('should update when the year changes', () => {
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2027, 6, 1));
      expect(getLatestYear()).toBe(2027);
    });

    it('should accept valid years', () => {
      expect(isValidYear(1999)).toBe(true);
      expect(isValidYear(2005)).toBe(true);
      expect(isValidYear(2015)).toBe(true);
      expect(isValidYear(2024)).toBe(true);
    });

    it('should reject years before 1999', () => {
      expect(isValidYear(1998)).toBe(false);
      expect(isValidYear(1990)).toBe(false);
    });

    it('should reject years after the current year', () => {
      expect(isValidYear(2025)).toBe(false);
      expect(isValidYear(2030)).toBe(false);
    });

    it('should handle year boundary on Dec 31', () => {
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2024, 12, 31));
      expect(isValidYear(2024)).toBe(true);
      expect(isValidYear(2025)).toBe(false);
    });

    it('should handle year boundary on Jan 1 (latest data day is yesterday)', () => {
      // On New Year's Day the latest data is 31 Dec, so the new year is not
      // yet a valid data year.
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 1));
      expect(isValidYear(2024)).toBe(true);
      expect(isValidYear(2025)).toBe(false);

      // A day later the new year has its first day of data.
      mockGetTodayAEST.mockReturnValue(new CalendarDate(2025, 1, 2));
      expect(isValidYear(2025)).toBe(true);
    });
  });

  describe('yearQueryOptions', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient();
    });

    it('keys queries by mode and year, plus the DTO version', () => {
      // CF_DTO_VERSION is part of the key so a payload-shape change invalidates
      // every cached year — see year-queries.ts. It replaced the per-deploy
      // build id, which no longer exists: a deploy cannot reach the cache of a
      // tab that is already open, so only a shape change should bust it.
      expect(yearQueryOptions(queryClient, 'full', 2023).queryKey).toEqual([
        'capFacYear',
        'full',
        2023,
        CF_DTO_VERSION,
      ]);
      expect(yearQueryOptions(queryClient, 'current', 2023).queryKey).toEqual([
        'capFacYear',
        'current',
        2023,
        CF_DTO_VERSION,
      ]);
    });

    it('keys the shared payload by year alone — no mode', () => {
      expect(yearDataQueryOptions(2023).queryKey).toEqual(['capFacYearData', 2023, CF_DTO_VERSION]);
    });

    it('gives the current year the short (hourly) staleTime', () => {
      expect(yearQueryOptions(queryClient, 'full', 2024).staleTime).toBe(
        YEAR_CACHE_TIERS.current.revalidateSeconds * 1000
      );
    });

    it('gives recent past years the daily staleTime (data is subject to revision)', () => {
      expect(yearQueryOptions(queryClient, 'full', 2023).staleTime).toBe(
        YEAR_CACHE_TIERS.recent.revalidateSeconds * 1000
      );
    });

    it('gives archive years a finite weekly staleTime — never Infinity', () => {
      expect(yearQueryOptions(queryClient, 'full', 2010).staleTime).toBe(
        YEAR_CACHE_TIERS.archive.revalidateSeconds * 1000
      );
    });

    it('gives the shared payload query the same staleTime as the views over it', () => {
      // If these drifted, a view could keep rebuilding tiles from a payload
      // that never revalidates, or vice versa.
      expect(yearDataQueryOptions(2023).staleTime).toBe(
        yearQueryOptions(queryClient, 'full', 2023).staleTime
      );
    });

    it('disables structural sharing (canvas-bearing cache values)', () => {
      expect(yearQueryOptions(queryClient, 'full', 2023).structuralSharing).toBe(false);
    });

    const payloadResponse = () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          type: 'capacity_factors',
          version: '1.0',
          created_at: '2026-08-07T12:00:00+10:00',
          data: [],
        }),
    });

    it('fetches once for both fleet views of a year', async () => {
      // The point of the two-layer split: switching the fleet toggle must not
      // hit the network. Both views resolve through one shared payload query.
      const fetchMock = vi.fn().mockResolvedValue(payloadResponse());
      global.fetch = fetchMock as unknown as typeof fetch;

      await queryClient.fetchQuery(yearQueryOptions(queryClient, 'full', 2023));
      await queryClient.fetchQuery(yearQueryOptions(queryClient, 'current', 2023));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      // ...and the request carries no fleet parameter.
      expect(fetchMock.mock.calls[0][0]).toBe('/api/capacity-factors?year=2023');
    });

    it('leaves retries to the payload query alone', () => {
      // Both layers would otherwise inherit retry: 3 (set in providers.tsx), so
      // one failing year would be 4 payload attempts retried 4 times — 16
      // requests behind a single tile.
      expect(yearQueryOptions(queryClient, 'full', 2023).retry).toBe(false);
      expect(yearDataQueryOptions(2023).retry).toBeUndefined();
    });

    it('does not build canvases for a year nobody is waiting for any more', async () => {
      // Panning fast across cold years: the payload lands long after the tile
      // that asked for it has gone. Painting ~33 canvases per abandoned year,
      // and caching them for gcTime, is pure waste.
      const fetchMock = vi.fn().mockResolvedValue(payloadResponse());
      global.fetch = fetchMock as unknown as typeof fetch;

      const controller = new AbortController();
      controller.abort();

      const { queryFn } = yearQueryOptions(queryClient, 'full', 2023);
      await expect(
        (queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)({
          signal: controller.signal,
        }),
      ).rejects.toThrow(/no longer needed/);

      // The shared payload still resolved — one view giving up must not deny
      // the other view (or a later revisit) the download it already paid for.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(['capFacYearData', 2023, CF_DTO_VERSION])).toBeDefined();
      expect(queryClient.getQueryData(['capFacYear', 'full', 2023, CF_DTO_VERSION])).toBeUndefined();
    });

    it('refetches the payload once it goes stale, rather than rebuilding from the old one', async () => {
      // The view sits on top of a shared payload query, so it would be easy to
      // resolve that payload in a way that returns whatever is cached however
      // old (ensureQueryData does exactly that). Revalidation would then be
      // dead: the view would keep re-rendering the same stale data. NEM figures
      // are revised, so this must genuinely go back to the network.
      const fetchMock = vi.fn().mockResolvedValue(payloadResponse());
      global.fetch = fetchMock as unknown as typeof fetch;

      await queryClient.fetchQuery(yearQueryOptions(queryClient, 'full', 2023));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Both layers carry the same staleTime, so they lapse together — which is
      // what a real revalidation looks like.
      await queryClient.invalidateQueries();
      await queryClient.fetchQuery(yearQueryOptions(queryClient, 'full', 2023));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
