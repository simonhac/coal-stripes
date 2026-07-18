import { test, expect, Page } from '@playwright/test';

/**
 * Real-browser gesture tests. These exercise the parts the pure unit tests
 * can't: real pointer velocity, real requestAnimationFrame-driven springs, and
 * real keyboard focus. The app exposes the current offset on the viz element as
 * `data-offset` (and the upper bound as `data-max-offset`) for assertions.
 */

const VIZ = '[data-testid="stripes-viz"]';

async function loadApp(page: Page) {
  // The welcome dialog auto-opens on a first visit as a full-viewport blocking
  // scrim that would intercept the pointer/wheel gestures under test. Mark it
  // seen before the app mounts so the viz stays interactable.
  await page.addInitScript(() => localStorage.setItem('welcome-dialog-seen', '1'));
  await page.goto('/');
  await page.locator(VIZ).waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect.poll(() => offset(page), { timeout: 60_000 }).not.toBeNull();
}

async function offset(page: Page): Promise<number | null> {
  const v = await page.locator(VIZ).getAttribute('data-offset');
  return v == null ? null : Number(v);
}

async function maxOffset(page: Page): Promise<number> {
  return Number(await page.locator(VIZ).getAttribute('data-max-offset'));
}

/** Wait until data-offset has been stable for a solid window (spring truly at
 *  rest, incl. the day-quantised tail + the final onRest commit). */
async function settle(page: Page): Promise<number> {
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

/** A drag across the viz. Coordinates are kept inside the 720px viewport (the viz
 *  itself is much taller). Fewer steps ⇒ faster ⇒ higher release velocity. */
async function dragX(
  page: Page,
  fromFrac: number,
  toFrac: number,
  opts: { steps?: number } = {},
) {
  const box = (await page.locator(VIZ).boundingBox())!;
  const vh = page.viewportSize()!.height;
  const y = Math.min(box.y + 220, vh - 120); // in the stripes, below the perf monitor, on-screen
  const x1 = box.x + box.width * fromFrac;
  const x2 = box.x + box.width * toFrac;
  await page.mouse.move(x1, y);
  await page.mouse.down();
  await page.mouse.move(x2, y, { steps: opts.steps ?? 12 });
  await page.mouse.up();
}

test.describe('gesture navigator', () => {
  test('loads at the present (offset == max)', async ({ page }) => {
    await loadApp(page);
    expect(await offset(page)).toBe(await maxOffset(page));
  });

  test('dragging right moves back in time (offset decreases)', async ({ page }) => {
    await loadApp(page);
    const before = (await offset(page))!;
    await dragX(page, 0.25, 0.75, { steps: 20 }); // slow drag right, low velocity
    const after = await settle(page);
    expect(after).toBeLessThan(before);
  });

  test('overscrolling past the present rubber-bands, then snaps back to exactly the present', async ({ page }) => {
    await loadApp(page);
    const max = await maxOffset(page);
    const box = (await page.locator(VIZ).boundingBox())!;
    const y = Math.min(box.y + 220, page.viewportSize()!.height - 120);
    // Manual drag so we can sample mid-gesture. From the present, dragging left
    // rubber-bands past the bound; on release it must snap back to exactly the present.
    await page.mouse.move(box.x + box.width * 0.85, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.1, y, { steps: 6 });
    const during = await offset(page);
    await page.mouse.up();
    const after = await settle(page);
    expect(during).toBeGreaterThan(max); // proved it rubber-banded past the present
    expect(after).toBe(max); // snapped back exactly — not stuck past it, not flung elsewhere
  });

  // ── REGRESSION: a hard backward flick from the present must move back a bounded
  //    amount, NOT fling to offset 0 (1 Jan 2006). ──
  test('a hard backward flick from the present is bounded (never zooms to 2006)', async ({ page }) => {
    await loadApp(page);
    const max = await maxOffset(page);
    await dragX(page, 0.15, 0.95, { steps: 2 }); // fast flick right (back in time)
    const after = await settle(page);
    expect(after).toBeLessThan(max); // it did move back (non-trivial)
    expect(after).toBeGreaterThan(0); // but NOT to offset 0 / 2006
    expect(max - after).toBeLessThan(700); // stayed within ~2 years of the present
  });

  test('trackpad/wheel scrolls the timeline and stays within bounds', async ({ page }) => {
    await loadApp(page);
    const max = await maxOffset(page);
    const box = (await page.locator(VIZ).boundingBox())!;
    const vh = page.viewportSize()!.height;
    await page.mouse.move(box.x + box.width * 0.5, Math.min(box.y + 220, vh - 120));
    const scroll = async (dx: number, n: number, gap = 40) => {
      for (let i = 0; i < n; i++) { await page.mouse.wheel(dx, 0); await page.waitForTimeout(gap); }
      await page.waitForTimeout(400);
    };

    await scroll(-200, 5); // scroll back a bit
    const back = await settle(page);
    expect(back).toBeLessThan(max);
    expect(back).toBeGreaterThan(0);

    await scroll(-500, 60, 10); // hard scroll back — must clamp at the start, never negative
    expect(await settle(page)).toBe(0);

    await scroll(500, 200, 5); // hard scroll forward — must clamp at the present, never past
    expect(await settle(page)).toBe(max);
  });

  test('trackpad overscroll past the present rubber-bands, then snaps back', async ({ page }) => {
    await loadApp(page);
    const max = await maxOffset(page);
    const box = (await page.locator(VIZ).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, Math.min(box.y + 220, page.viewportSize()!.height - 120));
    let peak = max;
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(300, 0); // scroll forward, past the present
      const o = await offset(page);
      if (o > peak) peak = o;
      await page.waitForTimeout(25);
    }
    const settled = await settle(page);
    expect(peak).toBeGreaterThan(max); // elastic overscroll past the present
    expect(settled).toBe(max); // snapped back to exactly the present
  });

  test('keyboard ArrowLeft glides back about a month (rAF runs in a real browser)', async ({ page }) => {
    await loadApp(page);
    const before = (await offset(page))!;
    await page.keyboard.press('ArrowLeft');
    const after = await settle(page);
    expect(after).toBeLessThan(before); // moved back
    expect(before - after).toBeLessThan(60); // ~1 month, not a huge jump
  });
});
