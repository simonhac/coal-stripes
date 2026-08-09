import { test, expect } from '@playwright/test';
import { loadApp, scrollTo } from './helpers';

/**
 * The date range readout has two homes: the page head, and — once that has
 * scrolled behind the sticky top bar — the pinned region header. These tests
 * cover the handover, and the tooltip's right to take the slot back.
 */

const PAGE_RANGE = '.opennem-date-range';
const REGION_RANGE = '.opennem-region-date-range';

test.describe('date range in the pinned region header', () => {
  test('the page head owns the readout until it scrolls out of sight', async ({ page }) => {
    await loadApp(page);

    await expect(page.locator(PAGE_RANGE)).toBeVisible();
    await expect(page.locator(REGION_RANGE)).toHaveCount(0);
  });

  test('the pinned region header picks it up, and shows the same dates', async ({ page }) => {
    await loadApp(page);
    const dates = (await page.locator(PAGE_RANGE).textContent())!;

    await scrollTo(page, 600);

    // Exactly one — the pinned region's, not every region's.
    const inHeader = page.locator(REGION_RANGE);
    await expect(inHeader).toHaveCount(1);
    await expect(inHeader).toBeVisible();
    await expect(inHeader).toHaveText(dates);

    // ...and it's inside a region header, in the tooltip's slot.
    await expect(page.locator(`.opennem-region-header ${REGION_RANGE}`)).toHaveCount(1);

    await scrollTo(page, 0);
    await expect(inHeader).toHaveCount(0);
  });

  test('a tooltip takes the slot back, and gives it up again', async ({ page }) => {
    await loadApp(page);
    await scrollTo(page, 600);
    await expect(page.locator(REGION_RANGE)).toHaveCount(1);

    // Hover a canvas that's already on screen, so Playwright doesn't scroll the
    // page out from under the test to reach it.
    const point = await page.evaluate(() => {
      for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
        const rect = canvas.getBoundingClientRect();
        if (rect.top > 120 && rect.bottom < window.innerHeight - 40 && rect.width > 100) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    });
    expect(point).not.toBeNull();

    await page.mouse.move(point!.x, point!.y);
    await page.mouse.move(point!.x + 3, point!.y);

    await expect(page.locator('.hover-date').first()).toBeVisible();
    await expect(page.locator(REGION_RANGE)).toHaveCount(0);

    // Off the stripes entirely — the date range comes back.
    await page.mouse.move(2, 2);
    await expect(page.locator(REGION_RANGE)).toHaveCount(1);
  });

  // The whole feature in one invariant, swept down the page: the date range is
  // on screen exactly once, and never in a header that's been clipped by the top
  // of the viewport. Both halves have been wrong — the readout used to stay with
  // a region whose header had already been shoved off, which you only notice at
  // the bottom of the page, where the last regions share the viewport and none
  // of their headers ever pins.
  for (const viewport of [
    { width: 360, height: 780, name: 'mobile' },
    { width: 1280, height: 720, name: 'desktop' },
  ]) {
    test(`${viewport.name}: exactly one copy, always in a header that's fully on screen`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loadApp(page);

      const maxScroll = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );

      for (let y = 0; y <= maxScroll; y += 60) {
        await scrollTo(page, y);
        const state = await page.evaluate(() => {
          const inHeader = document.querySelector('.opennem-region-date-range');
          const pageCopy = document.querySelector('.opennem-date-range')!.getBoundingClientRect();
          const bar = document.querySelector('.opennem-page-head header')!.getBoundingClientRect();
          return {
            count: document.querySelectorAll('.opennem-region-date-range').length,
            // The bar is opaque, so anything above its bottom edge is invisible.
            pageCopyVisible: pageCopy.bottom > bar.bottom,
            headerTop: inHeader
              ? Math.round(inHeader.closest('.opennem-region-header')!.getBoundingClientRect().top)
              : null,
          };
        });

        const where = `at scrollY=${y}: ${JSON.stringify(state)}`;
        if (state.pageCopyVisible) {
          expect(state.count, where).toBe(0);
        } else {
          expect(state.count, where).toBe(1);
          expect(state.headerTop!, where).toBeGreaterThanOrEqual(-1);
        }
      }
    });
  }

  test('it tracks navigation while scrolled', async ({ page }) => {
    await loadApp(page);
    await scrollTo(page, 600);

    const inHeader = page.locator(REGION_RANGE);
    const before = (await inHeader.textContent())!;

    await page.keyboard.press('ArrowLeft');

    await expect(inHeader).not.toHaveText(before, { timeout: 2000 });
    // Still agrees with the page-head copy, which is what it stands in for.
    await expect(inHeader).toHaveText((await page.locator(PAGE_RANGE).textContent())!);
  });
});
