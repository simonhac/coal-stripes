/**
 * The stale-document tripwire.
 *
 * It ships as a *string* of classic JavaScript — it has to, because the thing it
 * recovers from is every module on the page 404ing — so nothing typechecks it
 * and no bundler will tell you it is broken. That makes it exactly the kind of
 * code that works right up until the one moment it is needed. These tests run
 * the string.
 *
 * `unit` is `environment: 'node'`, so there is no DOM. That turns out to be a
 * feature rather than an obstacle: the script touches the outside world only
 * through `window`, so a hand-written fake window is enough, and it makes the
 * script's whole surface area visible in one object. No jsdom dependency.
 */
import {
  BOOT_FLAG,
  BOOT_TIMEOUT_MS,
  FRESH_PARAM,
  SELF_HEAL_GUARD,
  STALE_DOCUMENT_TRIPWIRE,
} from '@/client/stale-document-tripwire';

const HOME = 'https://stripes.energy/';
const APP_CHUNK = 'https://stripes.energy/assets/index-uN0Sv-iA.js';

interface FakeWindow {
  [key: string]: unknown;
  location: { href: string; replace: ReturnType<typeof vi.fn> };
  sessionStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
  addEventListener: (type: string, fn: (event: unknown) => void, capture?: boolean) => void;
}

function makeWindow({
  href = HOME,
  guarded = false,
  storageThrows = false,
}: { href?: string; guarded?: boolean; storageThrows?: boolean } = {}) {
  const items = new Map<string, string>();
  if (guarded) items.set(SELF_HEAL_GUARD, '1');

  const listeners = new Map<string, Array<(event: unknown) => void>>();

  const window: FakeWindow = {
    location: { href, replace: vi.fn() },
    get sessionStorage() {
      if (storageThrows) throw new Error('sessionStorage is disabled');
      return {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => { items.set(k, v); },
      };
    },
    addEventListener(type, fn) {
      const existing = listeners.get(type) ?? [];
      existing.push(fn);
      listeners.set(type, existing);
    },
  };

  return {
    window,
    items,
    /** Fire a resource load failure, as the browser would for a 404ing asset. */
    failResource(url: string | undefined, extra: Record<string, unknown> = {}) {
      for (const fn of listeners.get('error') ?? []) {
        fn({ target: { src: url, ...extra } });
      }
    },
  };
}

function arm(window: FakeWindow): void {
  // The script is an IIFE that closes over `window`; supplying it as a
  // parameter is exactly what the browser does with the global.
  new Function('window', STALE_DOCUMENT_TRIPWIRE)(window);
}

/** The URL the tripwire reloaded to, or undefined if it didn't. */
function reloadedTo(window: FakeWindow): URL | undefined {
  const call = window.location.replace.mock.calls[0];
  return call ? new URL(call[0] as string) : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stale document tripwire', () => {
  it('reloads past the cache when an asset 404s', () => {
    const { window, failResource } = makeWindow();
    arm(window);

    failResource(APP_CHUNK);

    const url = reloadedTo(window);
    // The cache-busting parameter is the whole mechanism: a plain reload is
    // answered by the same poisoned cache entry.
    expect(url?.searchParams.get(FRESH_PARAM)).toMatch(/^\d+$/);
    expect(url?.pathname).toBe('/');
  });

  it('keeps the search params that were already there', () => {
    const { window, failResource } = makeWindow({
      href: 'https://stripes.energy/?fleet=current',
    });
    arm(window);

    failResource(APP_CHUNK);

    expect(reloadedTo(window)?.searchParams.get('fleet')).toBe('current');
  });

  it('reloads once, however many assets fail', () => {
    const { window, failResource } = makeWindow();
    arm(window);

    failResource(APP_CHUNK);
    failResource('https://stripes.energy/assets/routes-BUIcaVg7.js');
    failResource('https://stripes.energy/assets/opennem-LaDgLB7m.css');

    expect(window.location.replace).toHaveBeenCalledTimes(1);
  });

  it('gives up rather than looping when a reload has already been tried', () => {
    const { window, failResource } = makeWindow({ guarded: true });
    arm(window);

    failResource(APP_CHUNK);

    expect(window.location.replace).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('records the attempt before reloading, so the next load knows', () => {
    const { window, items, failResource } = makeWindow();
    arm(window);

    failResource(APP_CHUNK);

    expect(items.get(SELF_HEAL_GUARD)).toBe('1');
  });

  it('still heals when sessionStorage throws, as it does in some privacy modes', () => {
    const { window, failResource } = makeWindow({ storageThrows: true });
    arm(window);

    failResource(APP_CHUNK);

    // Unguarded, but one reload of a broken page beats leaving it broken.
    expect(window.location.replace).toHaveBeenCalledTimes(1);
  });

  it('ignores failures that are not our hashed assets', () => {
    const { window, failResource } = makeWindow();
    arm(window);

    // Google Fonts, the analytics beacon, an <img>, and an error event with no
    // resource at all — none of these mean the document is stale.
    failResource('https://fonts.googleapis.com/css2?family=DM+Sans');
    failResource('https://static.cloudflareinsights.com/beacon.min.js/v451');
    failResource('https://stripes.energy/og-image.png');
    failResource(undefined);

    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('reloads if nothing has booted by the backstop timeout', () => {
    const { window } = makeWindow();
    arm(window);

    vi.advanceTimersByTime(BOOT_TIMEOUT_MS);

    expect(reloadedTo(window)?.searchParams.has(FRESH_PARAM)).toBe(true);
  });

  it('stays quiet once the app has booted', () => {
    const { window, failResource } = makeWindow();
    arm(window);

    window[BOOT_FLAG] = true;
    vi.advanceTimersByTime(BOOT_TIMEOUT_MS * 2);
    failResource(APP_CHUNK);

    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it('waits for the timeout rather than reloading a page that is merely slow', () => {
    const { window } = makeWindow();
    arm(window);

    vi.advanceTimersByTime(BOOT_TIMEOUT_MS - 1);

    expect(window.location.replace).not.toHaveBeenCalled();
  });
});
