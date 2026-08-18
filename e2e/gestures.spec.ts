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

/** Where navigation is HEADED, as opposed to `offset()` — where it has got to. */
async function targetOffset(page: Page): Promise<number | null> {
  const v = await page.locator(VIZ).getAttribute('data-target-offset');
  return v == null ? null : Number(v);
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

/**
 * How many wheel steps of `stepPx` it takes to cross the whole timeline, with
 * headroom.
 *
 * Derived rather than hard-coded, because the distance is not a constant: the
 * viz shows TILE_WIDTH (365) days across its full width, so a day is
 * `width / 365` pixels, and the timeline gains a day every day. A fixed step
 * count silently stops reaching the end — which is exactly what happened here.
 * The old `60 × 500px` budget covered ~30,000px of a ~31,000px timeline, so the
 * "hard scroll back" landed 28 days short of the start and never engaged the
 * clamp it was written to test.
 */
async function stepsToCrossTimeline(page: Page, stepPx: number): Promise<number> {
  const box = (await page.locator(VIZ).boundingBox())!;
  const pixelsPerDay = box.width / 365;
  const days = await maxOffset(page);
  return Math.ceil(((days * pixelsPerDay) / stepPx) * 1.4);
}

/**
 * Record every distinct `data-offset` the viz passes through, in the page, until
 * the returned stop function is called.
 *
 * A MutationObserver rather than Playwright polling: a glide is over in about a
 * second, and a round-trip per sample is far too coarse to tell a smooth
 * animation from a teleport.
 */
async function recordOffsets(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const w = window as unknown as { __offsets: number[]; __offsetObs: MutationObserver };
    w.__offsets = [Number(el.getAttribute('data-offset'))];
    w.__offsetObs = new MutationObserver(() => {
      const v = Number(el.getAttribute('data-offset'));
      if (v !== w.__offsets[w.__offsets.length - 1]) w.__offsets.push(v);
    });
    w.__offsetObs.observe(el, { attributes: true, attributeFilter: ['data-offset'] });
  }, VIZ);
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __offsets: number[]; __offsetObs: MutationObserver };
      w.__offsetObs.disconnect();
      return w.__offsets;
    });
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

/** A tap: pointer down and up at one point, under @use-gesture's 3px tapsThreshold.
 *  Same code path for a mouse click and a finger, so the desktop harness exercises
 *  the mobile bug. Returns the point, in the stripes, that was tapped. */
async function tapViz(page: Page, xFrac = 0.5) {
  const box = (await page.locator(VIZ).boundingBox())!;
  const y = Math.min(box.y + 220, page.viewportSize()!.height - 120);
  const x = box.x + box.width * xFrac;
  await page.mouse.move(x, y);
  await page.mouse.down();
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
    //
    // Stepped by hand and tracked as a running PEAK, rather than one reading
    // after a `{ steps: 6 }` burst. data-offset is published through a
    // transition-lane setState, so it lags the pointer by a step or more and a
    // single instantaneous sample can still be showing the pre-overshoot value
    // — which is a property of how the offset is observed, not of the gesture.
    // Same shape as the wheel overscroll test below.
    const x1 = box.x + box.width * 0.85;
    const x2 = box.x + box.width * 0.1;
    await page.mouse.move(x1, y);
    await page.mouse.down();
    let peak = max;
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x1 + (x2 - x1) * (i / 6), y);
      await page.waitForTimeout(25);
      const o = (await offset(page))!;
      if (o > peak) peak = o;
    }
    await page.mouse.up();
    const after = await settle(page);
    expect(peak).toBeGreaterThan(max); // proved it rubber-banded past the present
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

  // ── REGRESSION: the tap path used to publish `lastActivePRef`, which nothing
  //    writes during a tap — so it still held the *previous* drag's release px.
  //    After a flick that is the whole momentum travel behind where the stripes
  //    are, and the next touch rewound the entire scroll. ──
  test('a tap after a flick stays put (does not rewind to where the finger lifted)', async ({ page }) => {
    await loadApp(page);
    await dragX(page, 0.15, 0.95, { steps: 2 }); // fast flick right, hands off to momentum
    const settled = await settle(page);
    expect(await maxOffset(page) - settled).toBeGreaterThan(30); // the glide really travelled

    await tapViz(page);
    await page.waitForTimeout(500);
    expect(await offset(page)).toBe(settled);
    expect(await targetOffset(page)).toBe(settled);
  });

  test('a tap mid-glide arrests it where it is, and never rewinds', async ({ page }) => {
    await loadApp(page);
    const stop = await recordOffsets(page);
    await dragX(page, 0.15, 0.95, { steps: 2 });
    await page.waitForTimeout(200); // mid-glide
    await tapViz(page);
    await page.waitForTimeout(800); // long enough for the glide to have finished, had it run on
    const seen = await stop();

    // Dragging right walks back in time, so every reading must be ≤ the one before.
    // A rewind (the bug) shows up as an upward step; a resumed glide shows up as
    // continued movement long after the tap.
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    expect(await offset(page)).toBe(seen[seen.length - 1]);
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

    // Enough wheel travel to actually reach each end, whatever the viewport and
    // however long the timeline has grown — see stepsToCrossTimeline.
    const steps = await stepsToCrossTimeline(page, 500);

    await scroll(-500, steps, 10); // hard scroll back — must clamp at the start, never negative
    expect(await settle(page)).toBe(0);

    await scroll(500, steps, 5); // hard scroll forward — must clamp at the present, never past
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

  // The regression this whole target/animated split exists for. Every press used
  // to re-base off the *rendered* date — which the spring was still rewriting on
  // a low-priority transition lane — so three fast presses computed from
  // near-identical stale bases and travelled barely more than one month.
  test('three fast ArrowLefts compose to three months, not one', async ({ page }) => {
    await loadApp(page);
    const before = (await targetOffset(page))!;

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');

    // The target is reached synchronously on the keystroke — no settling first.
    const target = (await targetOffset(page))!;
    const travelled = before - target;
    expect(travelled).toBeGreaterThan(85);  // 3 calendar months ≈ 89-92 days
    expect(travelled).toBeLessThan(95);

    // ...and the stripes then glide to exactly that target.
    expect(await settle(page)).toBe(target);
  });

  // The header must not wait for the glide: the date is the answer to the
  // keypress, the animation is just how the stripes catch up.
  test('the date range header moves on the keystroke, ahead of the stripes', async ({ page }) => {
    await loadApp(page);
    const header = page.locator('.opennem-date-range');
    const beforeText = (await header.textContent())!;
    const beforeOffset = (await offset(page))!;

    await page.keyboard.press('ArrowLeft');

    // Header already shows the destination while the stripes are still en route.
    await expect(header).not.toHaveText(beforeText, { timeout: 1000 });
    expect(await offset(page)).not.toBe(await targetOffset(page));
    expect((await offset(page))!).toBeLessThanOrEqual(beforeOffset);

    // They reconcile once the spring rests.
    const settled = await settle(page);
    expect(settled).toBe(await targetOffset(page));
  });

  // The same decoupling, one level up: a press landing *during* a keyboard glide
  // must build on the target it is chasing, not on the half-finished animation.
  test('a keypress during an in-flight glide builds on the target, not the animation', async ({ page }) => {
    await loadApp(page);
    const before = (await targetOffset(page))!;

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(120); // well inside the ~700ms NAV_SPRING glide
    expect(await offset(page)).not.toBe(await targetOffset(page)); // genuinely mid-flight

    await page.keyboard.press('ArrowLeft');
    const target = (await targetOffset(page))!;
    const travelled = before - target;
    expect(travelled).toBeGreaterThan(55); // 2 calendar months ≈ 59-62 days
    expect(travelled).toBeLessThan(65);

    expect(await settle(page)).toBe(target);
  });

  // A year hop (⌘arrow) is ~365 days — just inside the glide budget from rest,
  // and comfortably outside it when measured from a half-finished glide. That is
  // how a second press used to trip `immediate: true` and teleport: the budget
  // was charged the unspent remainder of the first hop as well as the new one.
  // It must now bend the running spring toward the new year instead.
  test('a second Meta+ArrowLeft mid-glide keeps gliding instead of teleporting', async ({ page }) => {
    await loadApp(page);
    const before = (await targetOffset(page))!;
    const stop = await recordOffsets(page);

    await page.keyboard.press('Meta+ArrowLeft');
    await page.waitForTimeout(200); // well inside the ~700ms NAV_SPRING glide
    expect(await offset(page)).not.toBe(await targetOffset(page)); // genuinely mid-flight
    await page.keyboard.press('Meta+ArrowLeft');

    const settled = await settle(page);
    const samples = await stop();
    const target = (await targetOffset(page))!;

    expect(settled).toBe(target);
    expect(before - target).toBeGreaterThan(365); // two year hops, composed on the target

    // Bending the motion never reverses it.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThanOrEqual(samples[i - 1]);
    }

    // And no single step swallows the journey. A third of the total travel is a
    // deliberately loose bound — the point is to catch the teleport (one step of
    // ~500+ days) without going flaky when a cold year's tiles cost a long frame.
    const steps = samples.slice(1).map((v, i) => samples[i] - v);
    expect(Math.max(...steps)).toBeLessThan((before - target) / 3);
  });

  // Ctrl+S used to match the bare 's' binding, preventDefault the browser's
  // Save Page, and fling the timeline to the start of the data.
  test('Ctrl+S is left to the browser, not treated as "jump to start"', async ({ page }) => {
    await loadApp(page);
    const before = (await offset(page))!;
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(500);
    expect(await offset(page)).toBe(before);
  });

  // Alt+ArrowLeft is Back in Chrome and Firefox on Windows and Linux.
  test('Alt+ArrowLeft is left to the browser, not treated as a pan', async ({ page }) => {
    await loadApp(page);
    const before = (await offset(page))!;
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(500);
    expect(await offset(page)).toBe(before);
  });

  /**
   * The trackpad/touch equivalent of the two tests above: a horizontal pan must
   * not reach the browser as a swipe-back.
   *
   * Asserted on the ROOT element, which is the only place that works. The
   * viewport takes its overscroll behaviour from `html` and does NOT inherit it
   * from `<body>` — unlike `overflow`, which does. This has regressed once
   * already, by the rule being moved to `body` while the stylesheet still looked
   * correct at a glance, and it is invisible in CI and in devtools because the
   * declaration is present and computed either way. Playwright cannot synthesise
   * the OS-level swipe itself, so the reachable guarantee is that the rule lands
   * where the browser reads it.
   */
  test('the root element suppresses horizontal overscroll, so a pan is never a swipe-back', async ({ page }) => {
    await loadApp(page);
    const onRoot = await page.evaluate(
      () => getComputedStyle(document.documentElement).overscrollBehaviorX,
    );
    expect(onRoot).toBe('none');
  });
});
