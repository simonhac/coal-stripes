import { expect, Page } from '@playwright/test';

export const VIZ = '[data-testid="stripes-viz"]';

/** Load the app with the welcome dialog already dismissed, and data on screen. */
export async function loadApp(page: Page) {
  // The welcome dialog auto-opens on a first visit as a full-viewport blocking
  // scrim that would intercept everything under test; mark it seen before the
  // app mounts.
  await page.addInitScript(() => localStorage.setItem('welcome-dialog-seen', '1'));
  await page.goto('/');
  await page.locator(VIZ).waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect.poll(() => offset(page), { timeout: 60_000 }).not.toBeNull();
}

/** Where the stripes ARE, in days from the earliest valid end date. */
export async function offset(page: Page): Promise<number | null> {
  const v = await page.locator(VIZ).getAttribute('data-offset');
  return v == null ? null : Number(v);
}

/**
 * Wait until data-offset has been stable for a solid window — the spring truly
 * at rest, including the day-quantised tail and the final onRest commit.
 */
export async function settle(page: Page): Promise<number> {
  let prev = await offset(page);
  let stable = 0;
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(150);
    const cur = await offset(page);
    if (cur === prev) {
      if (++stable >= 6) return cur ?? 0; // ~900ms unchanged
    } else {
      stable = 0;
      prev = cur;
    }
  }
  return prev ?? 0;
}

/** Scroll the window, not the viz — a wheel over the viz is a pan gesture. */
export async function scrollTo(page: Page, y: number) {
  await page.evaluate(o => window.scrollTo(0, o), y);
  await page.waitForTimeout(200); // IntersectionObserver callbacks are async
}

/**
 * The centre of the first element matching `selector` that is fully on screen,
 * so a test can point at it with page.mouse without Playwright scrolling the
 * page out from under it.
 */
export async function onScreenCentre(
  page: Page,
  selector: string,
  minWidth = 20
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ sel, minW }) => {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        if (r.top > 120 && r.bottom < window.innerHeight - 40 && r.width > minW && r.height > 4) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    },
    { sel: selector, minW: minWidth }
  );
  expect(point, `no on-screen ${selector}`).not.toBeNull();
  return point!;
}
