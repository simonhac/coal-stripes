/**
 * The Data Cache layer's stampede guard.
 *
 * `unstable_cache` does not collapse concurrent misses, so several callers can
 * enter the wrapped function at once — a visitor and the cron sweep landing on
 * the same cold year, say. Without single-flight each would fan out to
 * OpenElectricity for identical data, which is the exact thing the warmer's
 * bounded fan-out makes more likely.
 *
 * `unstable_cache` is mocked to a pass-through here on purpose: that is
 * precisely the "every call is a miss" case the guard exists for, and it keeps
 * the test about the guard rather than about Next's caching.
 */

jest.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

const getCapacityFactors = jest.fn();

jest.mock('@/server/cap-fac-data-service', () => ({
  getCapFacDataService: () => ({ getCapacityFactors }),
}));

import { coldFetchCount, getCachedCapacityFactors } from '@/server/cf-cache';

/** A fetch we can hold open, so all callers are genuinely concurrent. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('cf-cache single-flight', () => {
  beforeEach(() => {
    getCapacityFactors.mockReset();
  });

  it('collapses concurrent misses for the same year into one upstream fetch', async () => {
    const gate = deferred<{ created_at: string }>();
    getCapacityFactors.mockReturnValue(gate.promise);

    // Use a year no other test in this file touches, so the module-level
    // cold-fetch counter starts from a known place.
    const before = coldFetchCount(2014);
    const callers = Array.from({ length: 4 }, () =>
      getCachedCapacityFactors(2014),
    );

    const payload = { created_at: '2026-08-07T12:00:00+10:00' };
    gate.resolve(payload);
    const results = await Promise.all(callers);

    expect(getCapacityFactors).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toBe(payload);
    // One upstream rebuild, not four — this is what the warm-all sweep counts.
    expect(coldFetchCount(2014) - before).toBe(1);
  });

  it('keeps different years separate, and collapses a repeated year', async () => {
    getCapacityFactors.mockImplementation((year: number) =>
      Promise.resolve({ created_at: String(year) }),
    );

    const [a, b, c] = await Promise.all([
      getCachedCapacityFactors(2015),
      getCachedCapacityFactors(2016),
      getCachedCapacityFactors(2015),
    ]);

    // Two fetches, not three: the year is the whole key now. This used to be
    // three, because (2015, full) and (2015, current) were separate entries.
    expect(getCapacityFactors).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ created_at: '2015' });
    expect(b).toEqual({ created_at: '2016' });
    expect(c).toBe(a);
  });

  it('does not strand later callers when a fetch fails', async () => {
    getCapacityFactors.mockRejectedValueOnce(new Error('upstream down'));

    await expect(getCachedCapacityFactors(2017)).rejects.toThrow('upstream down');

    // The in-flight entry must have been dropped, so a retry actually retries
    // rather than joining a promise that already rejected.
    getCapacityFactors.mockResolvedValueOnce({ created_at: 'ok' });
    await expect(getCachedCapacityFactors(2017)).resolves.toEqual({
      created_at: 'ok',
    });
    expect(getCapacityFactors).toHaveBeenCalledTimes(2);
  });
});
