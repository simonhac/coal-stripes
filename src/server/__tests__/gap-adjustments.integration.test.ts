/**
 * The gap adjustments, against the live OpenElectricity API.
 *
 * `totalHoleUnitDays` counts only the rows we emit, which is a floor: folding
 * Playford B's members into one row hides their own nulls, and the retired-unit
 * 0-fill covers days upstream left null. `dataQuality.adjustments` corrects for
 * both, and `totalUnitDaysAtSource` is what a reader would count by querying
 * OpenElectricity per DUID.
 *
 * This asserts the RELATIONSHIPS rather than the magnitudes. The magnitudes move
 * on their own — when OpenElectricity extended its record back to 7 Dec 1998 the
 * Playford figures went from +327/−57 to +403/−68 within hours — so pinning them
 * would produce a test that fails on someone else's backfill. The values are
 * logged instead, for comparison against a manual sweep of the API.
 *
 * Builds every year from the live API, so it is slow and opt-in:
 *   npm run test:integration -- gap-adjustments
 */
import { describe, expect, it } from 'vitest';
import { CapFacDataService } from '@/server/cap-fac-data-service';
import { computeCoalStats } from '@/server/coal-stats-service';
import { currentDataYear, earliestDataYear, yearRange } from '@/server/data-years';
import { readEnv } from '@/server/runtime-env';

describe('gap adjustments (live API)', () => {
  it('foots up from the counted gaps to the unit-level total', async () => {
    const service = new CapFacDataService(readEnv('OPENELECTRICITY_API_KEY')!);
    const years = yearRange(earliestDataYear(), currentDataYear());

    // Build once, serve from memory: computeCoalStats reads each year exactly
    // once, but going through the store would need a bucket binding.
    const built = new Map(
      await Promise.all(
        years.map(async (y) => [y, await service.getCapacityFactors(y)] as const)
      )
    );

    const stats = await computeCoalStats(async (year) => built.get(year) ?? null);
    const dq = stats.dataQuality;
    const adjustments = dq.adjustments ?? [];

    console.log('counted gaps        :', dq.totalHoleUnitDays, `(${dq.gaps.length} gaps)`);
    for (const a of adjustments) {
      console.log(`  ${a.unitDays >= 0 ? '+' : ''}${a.unitDays}`.padEnd(22), a.label);
    }
    console.log('total at source     :', dq.totalUnitDaysAtSource);

    // On 2026-08-15 this fold produced 10,178 counted + 403 − 68 + 101 = 10,614,
    // matching a manual per-DUID sweep of the API exactly. Those magnitudes are
    // deliberately not asserted — see the note at the top of this file.

    // The table's arithmetic, which is the whole point of the panel.
    expect(dq.totalUnitDaysAtSource).toBe(
      dq.totalHoleUnitDays + adjustments.reduce((sum, a) => sum + a.unitDays, 0)
    );
    expect(dq.totalHoleUnitDays).toBe(dq.gaps.reduce((sum, g) => sum + g.days, 0));

    // Playford B: its four members contribute gaps of their own, and the row
    // that absorbs them is scored from their first reading, so it over-counts.
    const folded = adjustments.find((a) => a.key === 'folded-into-PLAYB-AG');
    expect(folded, 'expected a folded-member adjustment').toBeDefined();
    expect(folded!.unitDays).toBeGreaterThan(0);
    expect(folded!.label).toContain('PLAYFB1');

    const span = adjustments.find((a) => a.key === 'absorbing-span-PLAYB-AG');
    expect(span, 'expected an absorbing-span credit').toBeDefined();
    expect(span!.unitDays).toBeLessThan(0);

    // At least one retired unit's 0-fill covers real nulls, because
    // OpenElectricity's data_last_seen under-reports its final reading.
    const fill = adjustments.find((a) => a.key === 'retired-fill');
    expect(fill, 'expected a retired-fill adjustment').toBeDefined();
    expect(fill!.unitDays).toBeGreaterThan(0);

    // Folded members are accounted for, never rendered: no gap may name one.
    expect(dq.gaps.filter((g) => g.duid.startsWith('PLAYFB'))).toEqual([]);
  }, 600_000);
});
