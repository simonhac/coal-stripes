import { test, expect, Page } from '@playwright/test';
import { loadApp, settle, scrollTo, onScreenCentre } from './helpers';

/**
 * A region or facility tooltip states an average over the window on screen, so
 * the moment the window moves the tooltip has to move with it — whether the
 * pointer is resting on the label or the tooltip is pinned and the pointer is
 * somewhere else entirely. These tests move the range and watch the readout.
 *
 * The tooltip used to carry a value computed once, at the moment of hover, so
 * every one of these failed: the dates and the percentage stayed at whatever
 * they were when the pointer arrived.
 */

const DATE = '.hover-date';
const VALUE = '.hover-values strong';
const REGION_RANGE = '.opennem-region-date-range';

/** The date line of the first region header showing a tooltip. */
function date(page: Page) {
  return page.locator(DATE).first();
}

function value(page: Page) {
  return page.locator(VALUE).first();
}

/** Navigate a month back and wait for the glide to finish. */
async function navigateBack(page: Page, key = 'ArrowLeft') {
  await page.keyboard.press(key);
  await settle(page);
}

test.describe('a showing tooltip follows the range', () => {
  test('hovering a region label: the dates track a keypress', async ({ page }) => {
    await loadApp(page);

    await page.locator('.opennem-region-label').first().hover();
    await expect(date(page)).toBeVisible();
    const before = (await date(page).textContent())!;

    await navigateBack(page);

    // Compared against itself, not the page-head readout: that one is formatted
    // more fully ("1 Jan 2024 – 31 Dec 2024" vs "1 Jan – 31 Dec 2024").
    await expect(date(page)).not.toHaveText(before);
  });

  test('a pinned region tooltip tracks repeated navigation, and stays pinned', async ({ page }) => {
    await loadApp(page);

    const label = await onScreenCentre(page, '.opennem-region-label');
    await page.mouse.click(label.x, label.y);
    await expect(date(page)).toBeVisible();

    // Off the label entirely — what follows is the pin's doing, not a hover's.
    await page.mouse.move(2, 2);
    await expect(date(page)).toBeVisible();

    let previous = (await date(page).textContent())!;
    for (let i = 0; i < 3; i++) {
      await navigateBack(page);
      const now = (await date(page).textContent())!;
      expect(now, `press ${i + 1}`).not.toBe(previous);
      previous = now;
    }

    // Still there: nothing along the way emitted a stray hover-end.
    await expect(date(page)).toBeVisible();
  });

  test('a pinned facility tooltip tracks both its dates and its value', async ({ page }) => {
    await loadApp(page);

    // The month axis contributes an empty .opennem-facility-label for alignment.
    const label = await onScreenCentre(page, '.opennem-facility-label', 40);
    await page.mouse.click(label.x, label.y);
    await expect(date(page)).toBeVisible();
    await page.mouse.move(2, 2);

    const beforeDate = (await date(page).textContent())!;
    const beforeValue = (await value(page).textContent())!;

    // Six months, so the average genuinely moves rather than rounding the same.
    await navigateBack(page, 'Shift+ArrowLeft');

    await expect(date(page)).not.toHaveText(beforeDate);
    await expect(value(page)).not.toHaveText(beforeValue);
  });

  test('every region header agrees on the period after navigating', async ({ page }) => {
    await loadApp(page);

    // Pinned rather than hovered: dwelling on a facility name raises the
    // hovercard, which lands over the label and takes the hover with it.
    const label = await onScreenCentre(page, '.opennem-facility-label', 40);
    await page.mouse.click(label.x, label.y);
    await expect(date(page)).toBeVisible();
    await page.mouse.move(2, 2);

    await navigateBack(page);

    const dates = await page.locator(DATE).allTextContents();
    expect(dates.length).toBeGreaterThan(1);
    expect(new Set(dates).size, `headers disagree: ${JSON.stringify(dates)}`).toBe(1);
  });

  test('a month bar under a stationary pointer names the month now under it', async ({ page }) => {
    await loadApp(page);

    const cell = await onScreenCentre(page, '.opennem-month-label');
    await page.mouse.move(cell.x, cell.y);
    await expect(date(page)).toBeVisible();
    const before = (await date(page).textContent())!;

    // The months slide left under the pointer, so the cell it is over is a
    // different month — and the readout has to say so.
    await navigateBack(page);
    await expect(date(page)).not.toHaveText(before);

    // The invariant behind that: the readout names whatever cell the pointer is
    // actually on. Swept across a pan, which moves the cells by a few days at a
    // time rather than a clean month.
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(60, 0);
      await settle(page);

      const label = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        return el?.closest('.opennem-month-label')?.textContent ?? null;
      }, cell);
      if (!label) continue; // pointer left the cells (the row's edges)

      await expect(date(page), `step ${i + 1}, over "${label}"`)
        .toHaveText(new RegExp(`^${label}\\b`));
    }
  });

  test('a value that cannot be computed yet resolves once the year lands', async ({ page }) => {
    await loadApp(page);

    const label = await onScreenCentre(page, '.opennem-region-label');
    await page.mouse.click(label.x, label.y);
    await expect(date(page)).toBeVisible();
    await page.mouse.move(2, 2);

    // Jump to the very start of the record — years nothing has fetched.
    await page.keyboard.press('s');
    await settle(page);

    // The pin survives the jump (it used to be cancelled outright when the
    // destination year wasn't cached), and the em dash becomes a percentage.
    await expect(date(page)).toBeVisible();
    await expect(value(page)).toHaveText(/%$/, { timeout: 30_000 });
  });

  test('a pinned tooltip still owns the borrowed date-range slot', async ({ page }) => {
    await loadApp(page);
    await scrollTo(page, 600);
    await expect(page.locator(REGION_RANGE)).toHaveCount(1);

    const label = await onScreenCentre(page, '.opennem-region-label');
    await page.mouse.click(label.x, label.y);
    await expect(page.locator(REGION_RANGE)).toHaveCount(0);

    // ...and still owns it after navigating, rather than handing the slot back.
    await navigateBack(page);
    await expect(page.locator(REGION_RANGE)).toHaveCount(0);

    // Unpinned, the date range comes back.
    await page.mouse.click(label.x, label.y);
    await expect(page.locator(REGION_RANGE)).toHaveCount(1);
  });
});
