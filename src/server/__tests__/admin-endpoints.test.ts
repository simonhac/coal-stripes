/**
 * The two admin endpoints, at the edges where they refuse work.
 *
 * Everything covered here returns before any binding or network is touched:
 * auth, body parsing and range checks. The happy paths are deliberately absent —
 * a real rebuild is a 3-9 s OpenElectricity fetch and a real purge is a
 * control-plane call, neither of which belongs in a unit test. What can go
 * wrong silently is the *validation*: an endpoint that accepts `{}` and does
 * nothing, or one that quietly rebuilds a future year that `isStorable` will
 * then decline to write.
 *
 * The handlers are reached through the route object rather than over HTTP,
 * because there is no server to run in this project — `cloudflare:workers` is
 * the Node stub (see test/mocks), whose `cache.purge` always succeeds and which
 * has no DATA binding at all.
 *
 * It lives under `server/__tests__` rather than beside the routes because the
 * router scans `src/routes` for files exporting a `Route` and warns about every
 * one that doesn't.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The unit project aliases `cloudflare:workers` to a mutable stub whose `env`
// is a snapshot of process.env (see test/mocks). TypeScript resolves the real
// generated `Env` instead, which has neither of these keys, so widen it here.
import { env as workerEnv } from 'cloudflare:workers';
import { Route as AuthRoute } from '@/routes/api.admin.auth';
import { Route as PurgeRoute } from '@/routes/api.admin.purge';
import { Route as RebuildRoute } from '@/routes/api.admin.rebuild';
import { Route as StoreRoute } from '@/routes/api.admin.store';
import { allDataYears, currentDataYear, earliestDataYear } from '@/server/data-years';

const env = workerEnv as unknown as Record<string, string | undefined>;

const SECRET = 'test-cache-secret';

type Handler = (args: { request: Request }) => Promise<Response>;

function handlerOf(route: unknown, method: 'GET' | 'POST' = 'POST'): Handler {
  return (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server
    .handlers[method];
}

const rebuild = handlerOf(RebuildRoute);
const purge = handlerOf(PurgeRoute);
const checkAuth = handlerOf(AuthRoute);
const storeStatusRoute = handlerOf(StoreRoute, 'GET');

function post(body?: unknown, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  return new Request('https://example.invalid/api/admin/x', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// `readEnv` prefers the worker `env` and falls back to `process.env`, so both
// have to be pinned — otherwise a CACHE_SECRET that happens to be in the
// machine's .env.local would quietly satisfy the "fails closed" case.
let savedSecret: string | undefined;
let savedProcessSecret: string | undefined;
let savedKey: string | undefined;

function setSecret(value: string | undefined) {
  env.CACHE_SECRET = value;
  if (value === undefined) delete process.env.CACHE_SECRET;
  else process.env.CACHE_SECRET = value;
}

beforeEach(() => {
  savedSecret = env.CACHE_SECRET;
  savedProcessSecret = process.env.CACHE_SECRET;
  savedKey = env.OPENELECTRICITY_API_KEY;
  setSecret(SECRET);
  // The purge endpoint clears the facilities memo, which constructs the data
  // service; it needs a key to exist, but never uses it here.
  env.OPENELECTRICITY_API_KEY = env.OPENELECTRICITY_API_KEY ?? 'not-a-real-key';
});

afterEach(() => {
  env.CACHE_SECRET = savedSecret;
  if (savedProcessSecret === undefined) delete process.env.CACHE_SECRET;
  else process.env.CACHE_SECRET = savedProcessSecret;
  env.OPENELECTRICITY_API_KEY = savedKey;
});

describe('POST /api/admin/rebuild', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await rebuild({ request: post({ year: currentDataYear() }, null) });
    expect(res.status).toBe(401);
  });

  it('rejects the wrong secret', async () => {
    const res = await rebuild({ request: post({ year: currentDataYear() }, 'nope') });
    expect(res.status).toBe(401);
  });

  it('fails closed when no secret is configured', async () => {
    setSecret(undefined);
    const res = await rebuild({ request: post({ year: currentDataYear() }) });
    expect(res.status).toBe(401);
  });

  it('rejects a body that is not JSON', async () => {
    const request = new Request('https://example.invalid/api/admin/rebuild', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
      body: 'not json',
    });
    const res = await rebuild({ request });
    expect(res.status).toBe(400);
  });

  it('rejects a body naming neither target', async () => {
    const res = await rebuild({ request: post({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('exactly one') });
  });

  it('rejects a body naming both targets', async () => {
    const res = await rebuild({ request: post({ year: currentDataYear(), stats: true }) });
    expect(res.status).toBe(400);
  });

  it('rejects a year that is not an integer', async () => {
    for (const year of ['nineteen', 2004.5, null]) {
      const res = await rebuild({ request: post({ year }) });
      expect(res.status, `year: ${String(year)}`).toBe(400);
    }
  });

  it('rejects a year before the data starts', async () => {
    const res = await rebuild({ request: post({ year: earliestDataYear() - 1 }) });
    expect(res.status).toBe(400);
  });

  // A future year is never stored, so a rebuild would fetch upstream, write
  // nothing, and report success. Saying no is the honest answer.
  it('rejects a future year', async () => {
    const res = await rebuild({ request: post({ year: currentDataYear() + 1 }) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/purge', () => {
  it('rejects the wrong secret', async () => {
    const res = await purge({ request: post(undefined, 'nope') });
    expect(res.status).toBe(401);
  });

  it('purges the root tags when no body is sent', async () => {
    const res = await purge({ request: post() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tags: ['capacity-factors', 'coal-stats', 'html'],
    });
  });

  it('purges only the tags asked for', async () => {
    const res = await purge({ request: post({ tags: ['cf-year-2004', 'coal-stats'] }) });
    expect(await res.json()).toMatchObject({ tags: ['cf-year-2004', 'coal-stats'] });
  });

  // The escape hatch should be hard to hold wrong: a malformed narrowing falls
  // back to the roots rather than purging nothing and reporting success.
  it('falls back to the root tags for an unusable tag list', async () => {
    for (const tags of [[], [1, 2], 'cf-year-2004', null]) {
      const res = await purge({ request: post({ tags }) });
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags, JSON.stringify(tags)).toEqual([
        'capacity-factors',
        'coal-stats',
        'html',
      ]);
    }
  });
});

// The page calls this once before fanning out, so that a mistyped passcode
// costs one request rather than 29 identical 401s painted across every row.
describe('POST /api/admin/auth', () => {
  it('accepts the right passcode with no body at all', async () => {
    const res = await checkAuth({ request: post(undefined) });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('rejects the wrong passcode', async () => {
    expect((await checkAuth({ request: post(undefined, 'nope') })).status).toBe(401);
  });

  it('rejects a missing header, and fails closed with no secret configured', async () => {
    expect((await checkAuth({ request: post(undefined, null) })).status).toBe(401);
    setSecret(undefined);
    expect((await checkAuth({ request: post(undefined) })).status).toBe(401);
  });

  // It must stay boring: an endpoint this cheap to call in a loop should say
  // nothing beyond yes-or-no, and must never be cacheable.
  it('says nothing beyond the verdict', async () => {
    const res = await checkAuth({ request: post(undefined) });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});

describe('GET /api/admin/store', () => {
  const get = () =>
    storeStatusRoute({ request: new Request('https://example.invalid/api/admin/store') });

  // Unauthenticated on purpose: every stamp it reports is already public on the
  // data routes' x-cf-built-at header and in /api/stats's sources block, and
  // gating it would leave the table blank until someone typed a passcode.
  it('needs no passcode to read', async () => {
    setSecret(undefined);
    expect((await get()).status).toBe(200);
  });

  it('lists every year plus the stats file, and never caches', async () => {
    const res = await get();
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const { entries } = (await res.json()) as {
      entries: { kind: string; year?: number; builtAt: string | null }[];
    };
    const years = allDataYears();
    expect(entries).toHaveLength(years.length + 1);
    expect(entries.filter((e) => e.kind === 'year').map((e) => e.year)).toEqual(years);
    expect(entries.at(-1)?.kind).toBe('stats');
  });

  // This project has no DATA binding (see test/mocks), which is the same shape
  // as a cold local bucket: report it, don't throw.
  it('reports an unbound store as never built rather than failing', async () => {
    const { entries } = (await (await get()).json()) as { entries: { builtAt: null }[] };
    expect(entries.every((e) => e.builtAt === null)).toBe(true);
  });
});
