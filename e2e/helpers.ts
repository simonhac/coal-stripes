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
 * The centre of the first element matching `selector` that a `page.mouse` click
 * would actually land on.
 *
 * The question these tests need answered is not "where is this element" but
 * "can I point at it" — the page has a sticky header, a sticky region header
 * and a portalled hovercard, any of which can cover a label that is perfectly
 * visible in the layout. So the test is the direct one: put the centre inside
 * the viewport, then ask the document what is on top there and require it to be
 * the element or something inside it.
 *
 * It used to approximate that with `top > 120 && bottom < innerHeight - 40`,
 * which is where this got interesting: at the default 1280×720 the first region
 * label sits at 111 and the second's bottom at 681, so the two guards missed by
 * 9px and 1px respectively and NO region label qualified. Two tests had been
 * failing on a margin nobody had reason to look at. Geometry guessed at the
 * answer; `elementFromPoint` knows it.
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
        if (r.width <= minW || r.height <= 4) continue;

        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;

        // Topmost at that point, and `el` is on the path a click would take:
        // either the hit IS `el`, or it is a descendant whose event bubbles
        // through it. An ancestor doesn't count — that means something has
        // taken `el` out of the hit path, and the click would miss.
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) return { x, y };
      }
      return null;
    },
    { sel: selector, minW: minWidth }
  );
  expect(point, `no clickable on-screen ${selector}`).not.toBeNull();
  return point!;
}
