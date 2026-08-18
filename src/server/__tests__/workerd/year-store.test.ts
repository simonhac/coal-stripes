/**
 * The R2 store, exercised against a real bucket.
 *
 * This runs inside **workerd** with miniflare's R2 implementation, not against a
 * hand-written stub, because the things worth pinning here are all properties of
 * R2 itself: that customMetadata survives a round trip, that `head` returns it
 * without the body, and that a missing key is a null rather than a throw. A mock
 * would assert our idea of R2, which is exactly the thing that could be wrong.
 *
 * These tests never reach OpenElectricity — every path exercised here is the
 * stored-object path. `readYear`'s upstream backfill is deliberately not covered:
 * it would need a live API key and would cost a real cold fetch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { now } from '@internationalized/date';
import { getStats, getYear, putStats, putYear, statsIsDue, statsKey, storeStatus, yearFreshness, yearIsDue, yearKey } from '@/server/year-store';
import { allDataYears, currentDataYear } from '@/server/data-years';
import { CF_DTO_VERSION, YEAR_CACHE_TIERS } from '@/shared/config';
import { getAESTDateTimeString } from '@/shared/date-utils';
import type { CoalGenerationStatsDTO, YearCapFacHistoryDTO } from '@/shared/types';

const bucket = (env as unknown as { DATA: R2Bucket }).DATA;

function payload(createdAt: string): YearCapFacHistoryDTO {
  return { type: 'capacity_factors', version: '1.0', created_at: createdAt, data: [] };
}

/** An AEST stamp `seconds` in the past, in the format the payloads carry. */
function stampSecondsAgo(seconds: number): string {
  // toDate() is the interop boundary getAESTDateTimeString expects; everything
  // up to it stays in @internationalized/date.
  return getAESTDateTimeString(now('Australia/Brisbane').subtract({ seconds }).toDate());
}

describe('year-store', () => {
  beforeEach(async () => {
    const listed = await bucket.list();
    await Promise.all(listed.objects.map((o) => bucket.delete(o.key)));
  });

  it('runs in workerd with an R2 binding', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    expect(bucket).toBeDefined();
  });

  it('namespaces keys by DTO version, so a bump cannot read the old shape', () => {
    expect(yearKey(2024)).toBe(`${CF_DTO_VERSION}/years/2024.json`);
    expect(statsKey()).toBe(`${CF_DTO_VERSION}/stats.json`);
  });

  it('round-trips a year unchanged, with builtAt in metadata', async () => {
    const dto = payload('2026-08-08T01:02:03+10:00');
    await putYear(2024, dto);

    const stored = await getYear(2024);
    expect(stored).not.toBeNull();
    // builtAt must be readable WITHOUT parsing the body — that is what lets the
    // read path stream 180 KB straight through.
    expect(stored!.customMetadata?.builtAt).toBe('2026-08-08T01:02:03+10:00');
    expect(await stored!.json()).toEqual(dto);
  });

  it('returns null for a year that was never stored', async () => {
    expect(await getYear(2003)).toBeNull();
  });

  it('never stores a future year', async () => {
    const future = currentDataYear() + 1;
    await putYear(future, payload(getAESTDateTimeString()));

    expect(await getYear(future)).toBeNull();
    // And it is never due, so the refresher won't spend a build on it either.
    expect(await yearIsDue(future)).toBe(false);
  });

  it('round-trips the stats payload', async () => {
    const dto = {
      type: 'coal_generation_stats',
      version: '1.0',
      created_at: '2026-08-08T01:02:03+10:00',
      latestDataDay: '2026-08-07',
      units: 'MWh',
      rows: [],
      dataQuality: { totalHoleUnitDays: 0, gaps: [] },
    } as CoalGenerationStatsDTO;

    await putStats(dto);

    const stored = await getStats();
    expect(stored).not.toBeNull();
    expect(await stored!.json()).toEqual(dto);
  });

  describe('statsIsDue', () => {
    const stats = (createdAt: string) => ({
      type: 'coal_generation_stats',
      version: '1.0',
      created_at: createdAt,
      latestDataDay: '2026-08-07',
      units: 'MWh',
      rows: [],
      dataQuality: { totalHoleUnitDays: 0, gaps: [] },
    }) as CoalGenerationStatsDTO;

    it('is due when nothing is stored', async () => {
      expect(await statsIsDue()).toBe(true);
    });

    it('is not due immediately after a write', async () => {
      await putStats(stats(getAESTDateTimeString()));
      expect(await statsIsDue()).toBe(false);
    });

    // The backstop: if a fold fails after years were written, later ticks see an
    // unchanged set of years, so age is the only thing that can trigger a retry.
    it('is due once a day old, even though no year moved', async () => {
      await putStats(stats(stampSecondsAgo(60 * 60 * 25)));
      expect(await statsIsDue()).toBe(true);
    });
  });

  // What the slot arithmetic itself guarantees — one rebuild per window, years
  // of a tier on different boundaries — is pinned in refresh-schedule.test.ts,
  // which needs no bucket. These cover only the wiring: that the stored
  // metadata is what the decision is made from.
  describe('yearIsDue', () => {
    it('is due when nothing is stored', async () => {
      expect(await yearIsDue(2024)).toBe(true);
    });

    it('is not due again within the same window', async () => {
      const archiveYear = currentDataYear() - 10;
      await putYear(archiveYear, payload(getAESTDateTimeString()));

      const inAnHour = now('Australia/Brisbane').add({ hours: 1 });
      expect(await yearIsDue(archiveYear, inAnHour)).toBe(false);
    });

    it('is due once its window has certainly elapsed', async () => {
      const archiveYear = currentDataYear() - 10;
      await putYear(archiveYear, payload(getAESTDateTimeString()));

      const inTwoWeeks = now('Australia/Brisbane').add({ weeks: 2 });
      expect(await yearIsDue(archiveYear, inTwoWeeks)).toBe(true);
    });

    it('rewrites an object whose builtAt is missing or unparseable', async () => {
      // Written by something that predates this scheme.
      await bucket.put(yearKey(2024), JSON.stringify(payload('x')), {
        customMetadata: { builtAt: 'not a timestamp' },
      });
      expect(await yearIsDue(2024)).toBe(true);

      await bucket.put(yearKey(2024), JSON.stringify(payload('x')));
      expect(await yearIsDue(2024)).toBe(true);
    });
  });

  describe('yearFreshness', () => {
    it('reports the age alongside the answer, so the sweep needs only one HEAD', async () => {
      const archiveYear = currentDataYear() - 10;
      const week = YEAR_CACHE_TIERS.archive.revalidateSeconds;
      await putYear(archiveYear, payload(stampSecondsAgo(week * 2)));

      const { due, ageSeconds } = await yearFreshness(archiveYear);
      expect(due).toBe(true);
      expect(ageSeconds).toBeGreaterThan(week * 2 - 60);
      expect(ageSeconds).toBeLessThan(week * 2 + 60);
    });

    it('has no age to report when nothing is stored', async () => {
      expect(await yearFreshness(2024)).toEqual({ due: true, ageSeconds: null });
    });
  });

  // The distinction the whole purge-and-refold path hangs off: a rebuild that
  // re-fetched identical numbers must not look like a revision, or the current
  // year's hourly rewrite refolds the stats 24 times a day for nothing.
  describe('change detection', () => {
    // Only a VALUE can move a year's hash now. Every field that used to change
    // without the numbers changing — `last_seen` above all, which advanced daily
    // for every operating unit and so rewrote the year 2000 every night — has
    // left the year payload for the metadata blob. See @/shared/unit-metadata.
    const withData = (createdAt: string, secondDay: number): YearCapFacHistoryDTO => ({
      type: 'capacity_factors',
      version: '1.0',
      created_at: createdAt,
      data: [{
        duid: 'BW01',
        history: {
          start: '2024-01-01',
          last: '2024-01-02',
          interval: '1d',
          data: [50, secondDay],
        },
      }],
    });

    it('reports the first write as a change', async () => {
      const write = await putYear(2024, withData('2026-08-08T01:00:00+10:00', 60));
      expect(write.changed).toBe(true);
      expect(write.dataChangedAt).toBe('2026-08-08T01:00:00+10:00');
    });

    it('does not count a rebuild with identical numbers as a change', async () => {
      await putYear(2024, withData('2026-08-08T01:00:00+10:00', 60));
      const second = await putYear(2024, withData('2026-08-08T02:00:00+10:00', 60));

      expect(second.changed).toBe(false);
      // builtAt still advances — otherwise the year stays due and is re-fetched
      // on every tick — but dataChangedAt holds at the last real revision.
      expect(second.dataChangedAt).toBe('2026-08-08T01:00:00+10:00');
      const stored = await getYear(2024);
      expect(stored!.customMetadata?.builtAt).toBe('2026-08-08T02:00:00+10:00');
      expect(stored!.customMetadata?.dataChangedAt).toBe('2026-08-08T01:00:00+10:00');
    });

    it('reports a change when a single number moves', async () => {
      await putYear(2024, withData('2026-08-08T01:00:00+10:00', 60));
      const second = await putYear(2024, withData('2026-08-08T02:00:00+10:00', 70));

      expect(second.changed).toBe(true);
      expect(second.dataChangedAt).toBe('2026-08-08T02:00:00+10:00');
    });

    it('applies the same rule to the stats payload', async () => {
      const stats = (createdAt: string, holes: number) => ({
        type: 'coal_generation_stats',
        version: '1.0',
        created_at: createdAt,
        latestDataDay: '2026-08-07',
        units: 'MWh',
        rows: [],
        dataQuality: { totalHoleUnitDays: holes, gaps: [] },
      }) as CoalGenerationStatsDTO;

      expect((await putStats(stats('2026-08-08T01:00:00+10:00', 0))).changed).toBe(true);
      expect((await putStats(stats('2026-08-08T02:00:00+10:00', 0))).changed).toBe(false);
      expect((await putStats(stats('2026-08-08T03:00:00+10:00', 5))).changed).toBe(true);
    });
  });

  // What the cache-management page reads. The value of this sweep is that it
  // costs HEADs rather than 5 MB of payloads, so the assertions worth making are
  // about completeness and about the metadata surviving without a body read.
  describe('storeStatus', () => {
    it('reports the metadata, every year oldest-first, then the stats file', async () => {
      const entries = await storeStatus();
      const years = allDataYears();

      // Metadata leads: every year joins against it, so it is the first thing to
      // check when the whole store looks wrong.
      expect(entries).toHaveLength(years.length + 2);
      expect(entries[0]).toMatchObject({ kind: 'metadata' });
      expect(entries.slice(1, years.length + 1).map((e) => e.year)).toEqual(years);
      expect(entries[entries.length - 1]).toMatchObject({ kind: 'stats' });
    });

    it('reports a never-built file as null rather than an error', async () => {
      const entries = await storeStatus();

      // An empty bucket is a legitimate state — a fresh local `wrangler dev` —
      // and the page shows it as "never built", not as a failure.
      for (const entry of entries) {
        expect(entry.builtAt).toBeNull();
        expect(entry.dataChangedAt).toBeNull();
        expect(entry.sizeBytes).toBeNull();
      }
    });

    it('carries both stamps and the size, read from metadata without the body', async () => {
      const year = currentDataYear() - 3;
      await putYear(year, payload('2026-08-08T01:00:00+10:00'));
      await putYear(year, payload('2026-08-08T02:00:00+10:00'));

      const entry = (await storeStatus()).find((e) => e.year === year);
      expect(entry?.builtAt).toBe('2026-08-08T02:00:00+10:00');
      // The numbers never moved, so only the build stamp advanced.
      expect(entry?.dataChangedAt).toBe('2026-08-08T01:00:00+10:00');
      expect(entry?.sizeBytes).toBeGreaterThan(0);
    });

    it('flags a year past twice its window as stale', async () => {
      const archiveYear = currentDataYear() - 10;
      const week = YEAR_CACHE_TIERS.archive.revalidateSeconds;

      await putYear(archiveYear, payload(stampSecondsAgo(60)));
      expect((await storeStatus()).find((e) => e.year === archiveYear)?.stale).toBe(false);

      await putYear(archiveYear, payload(stampSecondsAgo(week * 2 + 60)));
      expect((await storeStatus()).find((e) => e.year === archiveYear)?.stale).toBe(true);
    });
  });
});
