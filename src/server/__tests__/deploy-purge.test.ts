/**
 * The post-deploy document purge, at the edges where it decides.
 *
 * Worth testing because the interesting part is a window, and both ends of it
 * were chosen for a reason a future reader could easily talk themselves out of.
 * The upper bound is TWO cron intervals rather than one: the entry that poisons
 * the edge is written a second *after* the version flip, so a tick firing in
 * that same second purges too early and the second tick is the one that
 * actually works. The lower bound rejects negative ages, so a skewed clock
 * cannot turn this into a cron that purges the document cache on every tick
 * forever.
 *
 * The real numbers from the 2026-08-15 incident are used as the fixture rather
 * than round ones, so the test says out loud what it is reconstructing.
 */
import { parseAbsolute, type ZonedDateTime } from '@internationalized/date';
import {
  CRON_INTERVAL_SECONDS,
  PURGE_WINDOW_SECONDS,
  purgeDocumentsAfterDeploy,
  shouldPurgeDocuments,
  versionAgeSeconds,
} from '@/server/deploy-purge';
import { DOCUMENT_TAG } from '@/server/cache-headers';

/** Version 93ad4084, the deploy that stranded a document for an hour. */
const DEPLOYED_AT = '2026-08-15T12:06:19.675Z';

function at(iso: string): ZonedDateTime {
  return parseAbsolute(iso, 'UTC');
}

describe('versionAgeSeconds', () => {
  it('measures from the version upload, in seconds', () => {
    expect(versionAgeSeconds(DEPLOYED_AT, at('2026-08-15T12:16:19.675Z'))).toBe(600);
  });

  it('returns null rather than NaN for a timestamp it cannot parse', () => {
    expect(versionAgeSeconds('not a timestamp', at('2026-08-15T12:16:19.675Z'))).toBeNull();
  });
});

describe('shouldPurgeDocuments', () => {
  it('purges on the tick right after a deploy', () => {
    // The cron fired at 12:10; the deploy was 3m40s earlier.
    expect(shouldPurgeDocuments(DEPLOYED_AT, at('2026-08-15T12:10:00Z'))).toBe(true);
  });

  it('purges again on the following tick, which is the point of the window', () => {
    // A tick in the same second as the flip would purge before the poisoning
    // write lands. This one cannot: it is a full interval later.
    expect(shouldPurgeDocuments(DEPLOYED_AT, at('2026-08-15T12:20:00Z'))).toBe(true);
  });

  it('stops once the version is older than two intervals', () => {
    expect(shouldPurgeDocuments(DEPLOYED_AT, at('2026-08-15T12:30:00Z'))).toBe(false);
  });

  it('holds exactly at the boundary and lets go one second past it', () => {
    const boundary = at('2026-08-15T12:06:19.675Z').add({ seconds: PURGE_WINDOW_SECONDS });

    expect(shouldPurgeDocuments(DEPLOYED_AT, boundary)).toBe(true);
    expect(shouldPurgeDocuments(DEPLOYED_AT, boundary.add({ seconds: 1 }))).toBe(false);
  });

  it('covers at least two cron ticks, whatever the interval is set to', () => {
    // The window is derived from the cron interval; if someone changes one
    // without the other, this is what says so.
    expect(PURGE_WINDOW_SECONDS).toBeGreaterThanOrEqual(CRON_INTERVAL_SECONDS * 2);
  });

  it('fails closed on a version timestamped in the future', () => {
    // Clock skew. Failing open here would purge on every tick, for good.
    expect(shouldPurgeDocuments(DEPLOYED_AT, at('2026-08-15T12:00:00Z'))).toBe(false);
  });

  it('fails closed on a timestamp it cannot parse', () => {
    expect(shouldPurgeDocuments('', at('2026-08-15T12:10:00Z'))).toBe(false);
  });
});

describe('purgeDocumentsAfterDeploy', () => {
  const version = { id: '93ad4084', tag: '', timestamp: DEPLOYED_AT };

  function fakeCache(success = true) {
    return {
      purge: vi.fn(async () => ({ success, errors: [] as unknown[] })),
    };
  }

  it('purges only the document tag — years and stats are nothing to do with a deploy', async () => {
    const target = fakeCache();

    const result = await purgeDocumentsAfterDeploy(
      version,
      at('2026-08-15T12:10:00Z'),
      target as unknown as CacheContext,
    );

    expect(target.purge).toHaveBeenCalledWith({ tags: [DOCUMENT_TAG] });
    expect(result.purged).toBe(true);
  });

  it('does nothing on an ordinary tick', async () => {
    const target = fakeCache();

    const result = await purgeDocumentsAfterDeploy(
      version,
      at('2026-08-15T18:00:00Z'),
      target as unknown as CacheContext,
    );

    expect(target.purge).not.toHaveBeenCalled();
    expect(result.purged).toBe(false);
    // Still reports the age, so a tail can tell "not due" from "no binding".
    expect(result.ageSeconds).toBeGreaterThan(0);
  });

  it('reports a rejected purge rather than claiming success', async () => {
    const target = fakeCache(false);

    const result = await purgeDocumentsAfterDeploy(
      version,
      at('2026-08-15T12:10:00Z'),
      target as unknown as CacheContext,
    );

    expect(result.purged).toBe(false);
  });

  it('survives a purge that throws — a failed sweep must still run', async () => {
    const target = { purge: vi.fn(async () => { throw new Error('control plane down'); }) };

    const result = await purgeDocumentsAfterDeploy(
      version,
      at('2026-08-15T12:10:00Z'),
      target as unknown as CacheContext,
    );

    expect(result.purged).toBe(false);
  });

  it('says so when there is no version binding at all', async () => {
    const result = await purgeDocumentsAfterDeploy(undefined, at('2026-08-15T12:10:00Z'));

    expect(result).toEqual({ purged: false, ageSeconds: null });
  });
});
