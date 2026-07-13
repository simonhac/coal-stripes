import { yearCachePolicy, YEAR_CACHE_TIERS } from '../config';

// NEM data is subject to revision — e.g. January can revise the December just
// past — so no tier may be immutable and the boundaries matter.
describe('yearCachePolicy', () => {
  const CURRENT = 2026;

  it('puts the current year in the hourly tier', () => {
    expect(yearCachePolicy(CURRENT, CURRENT).tier).toBe('current');
  });

  it('puts future years in the current tier (headers handle no-store separately)', () => {
    expect(yearCachePolicy(CURRENT + 1, CURRENT).tier).toBe('current');
  });

  it('puts the last five past years in the daily tier', () => {
    expect(yearCachePolicy(CURRENT - 1, CURRENT).tier).toBe('recent');
    expect(yearCachePolicy(CURRENT - 5, CURRENT).tier).toBe('recent');
  });

  it('puts older years in the weekly archive tier', () => {
    expect(yearCachePolicy(CURRENT - 6, CURRENT).tier).toBe('archive');
    expect(yearCachePolicy(2006, CURRENT).tier).toBe('archive');
  });

  it('returns the tier windows alongside the tier', () => {
    const policy = yearCachePolicy(CURRENT - 1, CURRENT);
    expect(policy.revalidateSeconds).toBe(YEAR_CACHE_TIERS.recent.revalidateSeconds);
    expect(policy.swrSeconds).toBe(YEAR_CACHE_TIERS.recent.swrSeconds);
  });

  it('refreshes more often the more recent the year', () => {
    expect(YEAR_CACHE_TIERS.current.revalidateSeconds)
      .toBeLessThan(YEAR_CACHE_TIERS.recent.revalidateSeconds);
    expect(YEAR_CACHE_TIERS.recent.revalidateSeconds)
      .toBeLessThan(YEAR_CACHE_TIERS.archive.revalidateSeconds);
  });

  it('never exceeds a week between revalidations (revisions must propagate)', () => {
    const oneWeek = 60 * 60 * 24 * 7;
    for (const tier of Object.values(YEAR_CACHE_TIERS)) {
      expect(tier.revalidateSeconds).toBeLessThanOrEqual(oneWeek);
    }
  });
});
