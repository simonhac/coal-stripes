/**
 * The roster snapshot: the page's remembered shape, used to draw a reload's
 * shell before any data arrives.
 *
 * The contract worth testing is not the happy path — it is that every way this
 * can be wrong degrades to `null`, i.e. to the spinner the page showed before
 * the snapshot existed. A snapshot that threw, or that returned a half-parsed
 * roster, would turn a slow reload into a broken page.
 *
 * `unit` is `environment: 'node'`, so there is no DOM; a fake `window` carrying
 * nothing but a localStorage is all this module touches.
 */
import { loadRosterSnapshot, saveRosterSnapshot, type RosterFacility } from '@/client/roster-snapshot';
import { CF_DTO_VERSION } from '@/shared/config';

const KEY = 'roster-snapshot:full';

function installStore(store: Map<string, string>, opts: { throws?: boolean } = {}) {
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => {
        if (opts.throws) throw new Error('SecurityError');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throws) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
    },
  };
}

const ROSTER = new Map<string, RosterFacility[]>([
  ['NSW1', [{ code: 'BAYSW', name: 'Bayswater', height: 48 }]],
  ['QLD1', [{ code: 'CALL_B', name: 'Callide B', height: 24 }]],
]);

describe('roster snapshot', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    installStore(store);
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('round-trips a roster, heights included', () => {
    saveRosterSnapshot('full', ROSTER);
    expect(loadRosterSnapshot('full')).toEqual(ROSTER);
  });

  it('keys by fleet mode, because the two views hold different rosters', () => {
    saveRosterSnapshot('full', ROSTER);
    expect(loadRosterSnapshot('current')).toBeNull();
  });

  it('returns null on a first visit', () => {
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it('is invalidated by a DTO version bump', () => {
    store.set(
      KEY,
      JSON.stringify({
        dto: `${CF_DTO_VERSION}-old`,
        regions: [{ code: 'NSW1', facilities: [{ code: 'BAYSW', name: 'Bayswater', height: 48 }] }],
      })
    );
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', () => {
    store.set(KEY, '{not json');
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it.each([
    ['a non-object', '"a string"'],
    ['a missing regions array', JSON.stringify({ dto: CF_DTO_VERSION })],
    [
      'a facility with no name',
      JSON.stringify({ dto: CF_DTO_VERSION, regions: [{ code: 'NSW1', facilities: [{ code: 'BAYSW' }] }] }),
    ],
    [
      'a region with no code',
      JSON.stringify({ dto: CF_DTO_VERSION, regions: [{ facilities: [] }] }),
    ],
  ])('rejects %s', (_label, raw) => {
    store.set(KEY, raw);
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it('tolerates a facility with no recorded height', () => {
    store.set(
      KEY,
      JSON.stringify({ dto: CF_DTO_VERSION, regions: [{ code: 'NSW1', facilities: [{ code: 'BAYSW', name: 'Bayswater' }] }] })
    );
    expect(loadRosterSnapshot('full')).toEqual(
      new Map([['NSW1', [{ code: 'BAYSW', name: 'Bayswater', height: undefined }]]])
    );
  });

  it('survives a storage that throws (private mode, quota)', () => {
    installStore(store, { throws: true });
    expect(() => saveRosterSnapshot('full', ROSTER)).not.toThrow();
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it('is a no-op during SSR, where there is no window', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => saveRosterSnapshot('full', ROSTER)).not.toThrow();
    expect(loadRosterSnapshot('full')).toBeNull();
  });

  it('does not write an empty roster over a good one', () => {
    saveRosterSnapshot('full', ROSTER);
    saveRosterSnapshot('full', new Map());
    expect(loadRosterSnapshot('full')).toEqual(ROSTER);
  });
});
