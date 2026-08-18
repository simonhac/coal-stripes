import { test, expect } from '@playwright/test';
import { loadApp } from './helpers';

/**
 * The legend shares the date row: ramp on the left, dates on the right. What
 * these tests guard is that the two never reach each other — the row is one
 * line and there is no wrapping to absorb an overlap, so a font change or a
 * longer date string would show up here as a collision rather than as a
 * quietly ugly page.
 */

const LEGEND = '.opennem-legend';
const DATE = '.opennem-date-range';

/** Left edge, right edge and text of every tick that is actually rendered. */
async function ticks(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.opennem-legend-tick'))
      .filter(el => getComputedStyle(el).display !== 'none')
      .map(el => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent ?? '', left: r.left, right: r.right };
      })
  );
}

test.describe('the stripes legend', () => {
  test('sits left of the date, on the same row', async ({ page }) => {
    await loadApp(page);

    const legend = page.locator(LEGEND);
    await expect(legend).toBeVisible();

    const l = (await legend.boundingBox())!;
    const d = (await page.locator(DATE).boundingBox())!;

    // Left of the date, and clear of it.
    expect(l.x + l.width).toBeLessThan(d.x);
    // One row: the two boxes overlap vertically.
    expect(l.y).toBeLessThan(d.y + d.height);
    expect(d.y).toBeLessThan(l.y + l.height);
  });

  test('paints the ramp the stripes are painted from', async ({ page }) => {
    await loadApp(page);

    const gradient = await page
      .locator('.opennem-legend-bar')
      .evaluate(el => getComputedStyle(el).backgroundImage);

    // The offline red, the ramp's lightest grey and its black, in that order —
    // and the hard step at the threshold, which is the red and the grey both
    // claiming 20%.
    expect(gradient).toContain('rgb(199, 69, 35)');
    expect(gradient).toContain('rgb(191, 191, 191) 20%');
    expect(gradient).toContain('rgb(0, 0, 0) 100%');
  });

  test('marks the axis, threshold included, and keys the no-data blue', async ({ page }) => {
    await loadApp(page);

    expect((await ticks(page)).map(t => t.text)).toEqual(['0%', '20%', '50%', '100%']);
    await expect(page.locator('.opennem-legend-nodata')).toHaveText(/no data/);
  });

  /* The design system's rule for numbers, which this row broke for a while: a
     percentage is a value, and values are DM Mono with tabular figures. The
     month row at the foot of the stripes is the other axis on the page and
     already obeys it, so what is really being guarded is that the two go on
     agreeing. The "no data" caption beside them is prose, not a value, and
     stays in DM Sans — asserted here so a future sweep does not "fix" it. */
  test('sets its values in the mono face, and its caption in the body one', async ({ page }) => {
    await loadApp(page);

    const styleOf = (sel: string) =>
      page.locator(sel).first().evaluate(el => {
        const c = getComputedStyle(el);
        return { family: c.fontFamily, numeric: c.fontVariantNumeric };
      });

    const tick = await styleOf('.opennem-legend-tick');
    expect(tick.family).toContain('DM Mono');
    expect(tick.numeric).toContain('tabular-nums');

    const caption = await styleOf('.opennem-legend-nodata-label');
    expect(caption.family).toContain('DM Sans');
  });

  test('starts on the same edge as the labels below it', async ({ page }) => {
    await loadApp(page);

    // The text's edge, not the box's: both labels hold their words inside a
    // padded box, and it is the words the ramp lines up with.
    const edges = await page.evaluate(() => {
      const inkLeft = (el: Element | null) => {
        if (!el) return null;
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects());
        return rects.length ? Math.min(...rects.map(r => r.left)) : null;
      };
      return {
        bar: document.querySelector('.opennem-legend-bar')!.getBoundingClientRect().left,
        firstTick: document
          .querySelector('.opennem-legend-tick[data-anchor="start"]')!
          .getBoundingClientRect().left,
        region: inkLeft(document.querySelector('.opennem-region-label')),
        unit: inkLeft(document.querySelector('.opennem-facility-label')),
      };
    });

    expect(edges.region).not.toBeNull();
    expect(edges.bar).toBeCloseTo(edges.region!, 0);
    expect(edges.bar).toBeCloseTo(edges.unit!, 0);
    // Nothing hanging left of that edge: the `0%` label is anchored, not centred.
    expect(edges.firstTick).toBeCloseTo(edges.bar, 0);
  });

  test('keys no-data with a swatch on the bar\'s line, as wide as its own label', async ({ page }) => {
    await loadApp(page);

    const m = await page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return { bar: box('.opennem-legend-bar').toJSON(),
               swatch: box('.opennem-legend-swatch').toJSON(),
               label: box('.opennem-legend-nodata-label').toJSON(),
               tickLabel: box('.opennem-legend-tick[data-value="50"]').toJSON() };
    });

    // On the bar's line, and the same height.
    expect(m.swatch.top).toBeCloseTo(m.bar.top, 0);
    expect(m.swatch.height).toBeCloseTo(m.bar.height, 0);

    // As wide as the words beneath it, which sit on the tick labels' line.
    expect(m.swatch.width).toBeCloseTo(m.label.width, 0);
    expect(m.swatch.left).toBeCloseTo(m.label.left, 0);
    expect(m.label.bottom).toBeCloseTo(m.tickLabel.bottom, 0);
  });

  test('drops the threshold tick on a phone, and still fits beside the date', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await loadApp(page);

    // Three ticks, evenly readable: 20% is the one that goes.
    const rendered = await ticks(page);
    expect(rendered.map(t => t.text)).toEqual(['0%', '50%', '100%']);

    // Nothing clipped by the left edge of the screen: the mobile gutter is 4px
    // and there is no room for anything to hang outside the ramp.
    expect(Math.min(...rendered.map(t => t.left))).toBeGreaterThanOrEqual(0);

    // Nothing colliding with the date on the right.
    const d = (await page.locator(DATE).boundingBox())!;
    expect(Math.max(...rendered.map(t => t.right))).toBeLessThan(d.x);
    const nodata = (await page.locator('.opennem-legend-nodata').boundingBox())!;
    expect(nodata.x + nodata.width).toBeLessThan(d.x);
  });
});
