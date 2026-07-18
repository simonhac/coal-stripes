import { useEffect, useState } from 'react';

export interface DeviceCapabilities {
  /** macOS / iOS / iPadOS — decides whether to show ⌘ (cloverleaf) vs Ctrl. */
  isApple: boolean;
  /** Best-effort: does the device have a physical keyboard? (heuristic). */
  hasKeyboard: boolean;
  /** Touch-capable (phone / tablet / touchscreen). */
  isTouch: boolean;
  /** Desktop-like: fine pointer and not touch-primary. */
  isDesktop: boolean;
}

// Stable SSR / first-client-render default. Must be identical on the server and
// the first client render to avoid a hydration mismatch; the real values are
// filled in from a post-mount effect (a post-mount setState is not a mismatch).
const DEFAULT_CAPABILITIES: DeviceCapabilities = {
  isApple: false,
  hasKeyboard: true,
  isTouch: false,
  isDesktop: true,
};

// `navigator.userAgentData` is only loosely typed; keep a narrow local shape.
type UADataNavigator = Navigator & { userAgentData?: { platform?: string } };

function detectIsApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as UADataNavigator;

  // Preferred modern API (Chromium-family only; Safari/Firefox don't expose it).
  const uaPlatform = nav.userAgentData?.platform;
  if (uaPlatform && /mac/i.test(uaPlatform)) return true;

  // Deprecated but universally available. iPadOS 13+ reports "MacIntel".
  if (/mac|iphone|ipad|ipod/i.test(navigator.platform || '')) return true;

  // UA fallback (older iOS, or iPadOS masquerading as desktop Safari).
  if (/mac|iphone|ipad|ipod/i.test(navigator.userAgent || '')) return true;

  return false;
}

function mq(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  );
}

function computeCapabilities(): DeviceCapabilities {
  const isApple = detectIsApple();

  const maxTouchPoints =
    typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;

  const isTouch =
    maxTouchPoints > 0 ||
    (typeof window !== 'undefined' && 'ontouchstart' in window) ||
    mq('(any-pointer: coarse)');

  // A *fine* pointer being available (even on a hybrid whose primary pointer is
  // touch) implies a mouse/trackpad. `any-pointer`/`any-hover` are deliberate so
  // that iPad+trackpad and Surface count.
  const hasFinePointer = mq('(any-pointer: fine)') || mq('(pointer: fine)');
  const canHover = mq('(any-hover: hover)') || mq('(hover: hover)');

  // No reliable "has physical keyboard" API exists. Proxy: a device that can
  // hover or has a fine pointer is almost certainly a laptop/desktop, or a
  // hybrid with a keyboard attached. A bare phone reports coarse + no-hover.
  const hasKeyboard = hasFinePointer || canHover;

  const isDesktop = !isTouch && hasFinePointer;

  return { isApple, hasKeyboard, isTouch, isDesktop };
}

/**
 * SSR-safe device-capability detection. Returns stable defaults on the server
 * and first client render, then upgrades to the real values after mount and
 * whenever pointer/hover capability changes (e.g. a keyboard is attached).
 */
export function useDeviceCapabilities(): DeviceCapabilities {
  const [capabilities, setCapabilities] =
    useState<DeviceCapabilities>(DEFAULT_CAPABILITIES);

  useEffect(() => {
    setCapabilities(computeCapabilities());

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    // Re-detect when pointer/hover capability changes (mouse plug/unplug,
    // Magic Keyboard attach).
    const lists = [
      window.matchMedia('(any-pointer: fine)'),
      window.matchMedia('(any-hover: hover)'),
      window.matchMedia('(any-pointer: coarse)'),
    ];
    const onChange = () => setCapabilities(computeCapabilities());
    lists.forEach((l) => l.addEventListener('change', onChange));

    // Progressive enhancement: a genuine key press proves a keyboard exists.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || !e.key) return;
      setCapabilities((prev) =>
        prev.hasKeyboard ? prev : { ...prev, hasKeyboard: true }
      );
      window.removeEventListener('keydown', onKeyDown);
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      lists.forEach((l) => l.removeEventListener('change', onChange));
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return capabilities;
}
