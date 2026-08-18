/**
 * What a refresh looks like.
 *
 * The page used to be replaced wholesale by a 200px "Loading stripes…" box on
 * every single load — it was in the SSR'd HTML, so it painted before hydration,
 * and it stayed until two years of data had been fetched, parsed and rasterised.
 * A returning visitor paid that for a page whose shape had not changed since
 * their last visit.
 *
 * Now the shape is cached (roster-snapshot) and the shell is drawn from it, so
 * the tests below pin the three things that make a refresh calm: the spinner is
 * not in the HTML, the rows are on screen before their data, and they are
 * already the right height when the stripes arrive.
 *
 * The API is deliberately stalled here. Against a local dev server the real
 * thing answers in tens of milliseconds, which is far too fast to observe the
 * intermediate state — and it is precisely the intermediate state that used to
 * be ugly.
 */
import { test, expect, type Page } from '@playwright/test';

const VIZ = '[data-testid="stripes-viz"]';
const LOADING = '.opennem-loading';
const API = '**/api/capacity-factors*';

/** Long enough to inspect the shell at leisure, short enough not to bore CI. */
const STALL_MS = 4000;

async function seedWelcome(page: Page) {
  await page.addInitScript(() => localStorage.setItem('welcome-dialog-seen', '1'));
}

/** Row heights by facility, as laid out right now. */
async function rowHeights(page: Page): Promise<number[]> {
  return page.locator('.opennem-facility-canvas').evaluateAll(els =>
    els.map(el => Math.round(el.getBoundingClientRect().height))
  );
}

test.describe('reload', () => {
  test('the served HTML carries the header, and no spinner', async ({ page }) => {
    const response = await page.goto('/');
    const html = (await response!.text());

    // The whole point: nothing in the document announces loading, so there is
    // nothing to flash away when the app boots.
    expect(html).not.toContain('Loading stripes');
    expect(html).not.toContain('opennem-loading');

    // …and the top of the page is real, painted before any JavaScript runs.
    expect(html).toContain('opennem-page-head');
  });

  test('a first visit still shows the spinner, having nothing to draw', async ({ page }) => {
    await seedWelcome(page);
    await page.route(API, async route => {
      await new Promise(r => setTimeout(r, STALL_MS));
      await route.continue();
    });

    await page.goto('/');

    // No snapshot on a device that has never been here, so the spinner is the
    // honest answer — this is the one case it is for.
    await expect(page.locator(LOADING)).toBeVisible();
    await expect(page.locator(VIZ)).toHaveCount(0);

    // And it resolves into the real page once the data lands.
    await expect(page.locator(VIZ)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(LOADING)).toHaveCount(0);
  });

  test('a reload draws the rows before the data, at their final heights', async ({ page }) => {
    await seedWelcome(page);

    // First visit: let it load for real, which records the snapshot.
    await page.goto('/');
    await page.locator(VIZ).waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });
    const settledHeights = await rowHeights(page);
    expect(settledHeights.length).toBeGreaterThan(10);

    const snapshot = await page.evaluate(() => localStorage.getItem('roster-snapshot:full'));
    expect(snapshot).toBeTruthy();

    // The year payloads carry max-age=60, so a reload this soon would be served
    // from the browser's own cache — the request would never reach the network
    // layer, the stall below would never fire, and this test would quietly
    // become an assertion about an instant load. Disable the HTTP cache so the
    // reload genuinely has to wait for its data.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    // Now reload with the API stalled, so the shell is all there can be.
    let apiHits = 0;
    await page.route(API, async route => {
      apiHits++;
      await new Promise(r => setTimeout(r, STALL_MS));
      await route.continue();
    });
    // Registered before the reload, and awaited after the shell assertions —
    // waiting on `canvas` would not do, because the shell has canvases of its
    // own. That is the whole idea; it just makes canvas useless as a signal.
    const dataArrived = page.waitForResponse(
      r => r.url().includes('/api/capacity-factors') && r.status() === 200,
      { timeout: 60_000 }
    );
    await page.reload();

    // The rows are up while every year is still in flight…
    await expect(page.locator(VIZ)).toBeVisible();
    await expect(page.locator(LOADING)).toHaveCount(0);
    await expect(page.locator('.opennem-region-header').first()).toBeVisible();

    // …and "still in flight" is a fact, not an assumption: the stall fired, and
    // no tile has been painted yet.
    expect(apiHits).toBeGreaterThan(0);
    expect(await page.locator(VIZ).getAttribute('data-offset')).not.toBeNull();

    // …and they are already the size the stripes will need, so nothing below
    // them moves when the data lands. This is the assertion that would catch a
    // roster snapshot that had stopped recording heights.
    const shellHeights = await rowHeights(page);
    expect(shellHeights).toEqual(settledHeights);

    const shellPageHeight = await page.evaluate(() => document.body.scrollHeight);

    // Let the stalled data through, and confirm the page did not resize when it
    // landed — the shell was the finished layout all along.
    await dataArrived;
    await page.waitForLoadState('networkidle');

    expect(await rowHeights(page)).toEqual(settledHeights);
    expect(await page.evaluate(() => document.body.scrollHeight)).toBe(shellPageHeight);
  });

  test('a reload lands at the top of the page', async ({ page }) => {
    await seedWelcome(page);
    await page.goto('/');
    await page.locator(VIZ).waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });

    // A correctly-sized shell is exactly what makes scroll restoration possible
    // again, so this pins the wanted behaviour rather than assuming it.
    await page.evaluate(() => window.scrollTo(0, 2000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

    await page.reload();
    await page.locator(VIZ).waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('canvas').first().waitFor({ timeout: 60_000 });

    // Asserted after the data has landed and the page is at full height, which
    // is the moment restoration would have to happen if it were going to — an
    // earlier check would pass simply by being early.
    await expect
      .poll(() => page.evaluate(() => document.body.scrollHeight), { timeout: 30_000 })
      .toBeGreaterThan(1500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});
