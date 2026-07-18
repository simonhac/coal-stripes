/**
 * Persists whether the "Welcome to Stripes" dialog has already been shown, so
 * it only auto-opens on a visitor's first visit. Stored in localStorage to
 * match the rest of the app's client-flag persistence (see feature-flags.ts).
 */

const WELCOME_SEEN_KEY = 'welcome-dialog-seen';

/** True once the welcome dialog has been shown on this device. */
export function hasSeenWelcome(): boolean {
  // Never auto-open during SSR — we can't know, so assume seen.
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage?.getItem(WELCOME_SEEN_KEY) === '1';
  } catch {
    // Storage blocked (private mode / disabled): treat as first visit so the
    // onboarding still shows; it just can't be persisted across hard reloads.
    return false;
  }
}

/** Record that the welcome dialog has been shown. */
export function markWelcomeSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(WELCOME_SEEN_KEY, '1');
  } catch {
    /* private mode / quota exceeded — ignore */
  }
}
