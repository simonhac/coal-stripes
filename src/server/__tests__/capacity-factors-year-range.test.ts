/**
 * GET /api/capacity-factors, at the edge where it refuses work.
 *
 * The year range is the only validation this route has, and getting it wrong is
 * silent rather than loud. It used to accept 1900..2100, which meant a request
 * for a year outside the record spent a 3-9 s OpenElectricity fetch (both
 * networks answer NoDataFound, which the builder tolerates as empty) and then
 * *stored* the resulting all-null payload — `isStorable` only ever guarded the
 * upper end, so `v1/years/1900.json` was permanent litter anyone could create.
 *
 * Only the rejections are covered: an accepted year reaches `getYear`, which
 * needs a DATA binding the unit project does not have. The handler is reached
 * through the route object rather than over HTTP, for the reasons set out in
 * admin-endpoints.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { Route as CapacityFactorsRoute } from '@/routes/api.capacity-factors';
import { currentDataYear, earliestDataYear } from '@/server/data-years';

type Handler = (args: { request: Request }) => Promise<Response>;

const get = (
  (CapacityFactorsRoute as unknown as {
    options: { server: { handlers: Record<string, Handler> } };
  }).options.server.handlers.GET
);

const request = (query: string): Request =>
  new Request(`https://example.invalid/api/capacity-factors${query}`);

describe('GET /api/capacity-factors year range', () => {
  it('rejects a missing year', async () => {
    expect((await get({ request: request('') })).status).toBe(400);
  });

  it('rejects a year before the record starts', async () => {
    for (const year of [earliestDataYear() - 1, 1900, 1066]) {
      const res = await get({ request: request(`?year=${year}`) });
      expect(res.status, `year: ${year}`).toBe(400);
    }
  });

  it('rejects a future year rather than caching a payload of nulls', async () => {
    for (const year of [currentDataYear() + 1, 2100]) {
      const res = await get({ request: request(`?year=${year}`) });
      expect(res.status, `year: ${year}`).toBe(400);
    }
  });

  it('rejects a year that is not a number', async () => {
    expect((await get({ request: request('?year=nineteen') })).status).toBe(400);
  });

  it('names the accepted range, so a 400 is self-explanatory', async () => {
    const res = await get({ request: request('?year=1066') });
    const body = (await res.json()) as { error: string };

    expect(body.error).toContain(String(earliestDataYear()));
    expect(body.error).toContain(String(currentDataYear()));
  });

  it('never caches a rejection', async () => {
    const res = await get({ request: request('?year=1900') });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
