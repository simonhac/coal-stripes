/**
 * The single source of truth for keyboard shortcuts.
 *
 * Before this file the bindings were transcribed independently in three places
 * — the navigation listener, a second listener for the dialog toggles, and the
 * hand-written list in ShortcutsDialog — so they drifted. Worse, two of those
 * transcriptions disagreed about modifiers, and the navigation one simply
 * didn't check them: ⌘S called preventDefault() and flung the timeline to 1999
 * instead of letting the browser save the page.
 *
 * So a chord here declares its modifiers EXACTLY. Anything not listed must not
 * be held, which is what lets ⌘S, Alt+← and friends fall through to the
 * browser. The same data renders the shortcuts dialog, so the two can no
 * longer disagree.
 *
 * Pure and DOM-light on purpose: `matchesChord` is the interesting part, and it
 * belongs in the unit suite (src/shared/__tests__) rather than behind jsdom.
 */

// Tokens the app uses; anything else (letters, "Home", "?") renders verbatim.
export type KeyToken =
  | 'cmd'
  | 'shift'
  | 'alt'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | (string & {});

/** 'cmd' matches Cmd on Apple and Ctrl elsewhere, and renders accordingly. */
export type Modifier = 'cmd' | 'shift' | 'alt';

export type ShortcutGroup = 'Navigate' | 'Jump to' | 'Help';

/**
 * 'navigation' shortcuts are inert while a dialog is open or a drag is in
 * flight; 'global' ones stay live (that's how `a` / `?` close an open dialog).
 */
export type ShortcutScope = 'navigation' | 'global';

/** Everything `requires` is allowed to look at. Structural, so shared/ needn't
 *  import from hooks/. */
export interface ShortcutCapabilities {
  hasKeyboard: boolean;
}

export interface KeyChord {
  /** Compared to KeyboardEvent.key — case-insensitively when length === 1. */
  key: string;
  /** Required modifiers. Omitted or empty means "no modifiers at all". */
  mods?: readonly Modifier[];
  /** Handed to the handler; distinguishes ← from → within a single row. */
  arg?: number;
  /** Escape hatch for when the keycaps differ from the binding. */
  caps?: readonly KeyToken[];
}

export interface Shortcut {
  /** Stable id, and the key of the handler map. */
  id: string;
  group: ShortcutGroup;
  /** The right-hand column in ShortcutsDialog. */
  desc: string;
  scope: ShortcutScope;
  /** Alternative chords, in display order. */
  chords: readonly KeyChord[];
  /** Joiner rendered between chords in the dialog. */
  sep?: '/' | 'or';
  /** Gates both the binding and the dialog row. */
  requires?: (c: ShortcutCapabilities) => boolean;
}

/** Dialog section order. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'Navigate',
  'Jump to',
  'Help',
];

// Authored `as const` so ShortcutId can be derived from the data rather than
// maintained as a second list; re-exported widened below, because the const
// form narrows each entry to a type that simply lacks its absent optionals.
const SHORTCUTS_DEF = [
  {
    id: 'stepMonth',
    group: 'Navigate',
    scope: 'navigation',
    sep: '/',
    desc: 'Back / forward one month',
    chords: [
      { key: 'ArrowLeft', arg: -1 },
      { key: 'ArrowRight', arg: 1 },
    ],
  },
  {
    id: 'stepSixMonths',
    group: 'Navigate',
    scope: 'navigation',
    sep: '/',
    desc: 'Back / forward six months',
    chords: [
      { key: 'ArrowLeft', mods: ['shift'], arg: -6 },
      { key: 'ArrowRight', mods: ['shift'], arg: 6 },
    ],
  },
  {
    id: 'yearBoundary',
    group: 'Navigate',
    scope: 'navigation',
    sep: '/',
    desc: 'Jump to the previous / next year boundary',
    chords: [
      { key: 'ArrowLeft', mods: ['cmd'], arg: -1 },
      { key: 'ArrowRight', mods: ['cmd'], arg: 1 },
    ],
  },
  {
    id: 'toLatest',
    group: 'Jump to',
    scope: 'navigation',
    sep: 'or',
    desc: 'Latest data (the present)',
    chords: [{ key: 'Home' }, { key: 't' }],
  },
  {
    id: 'toStart',
    group: 'Jump to',
    scope: 'navigation',
    desc: 'Start of the data',
    chords: [{ key: 's' }],
  },
  {
    id: 'toggleShortcuts',
    group: 'Help',
    scope: 'global',
    desc: 'Show keyboard shortcuts',
    chords: [{ key: '?' }],
    requires: (c: ShortcutCapabilities) => c.hasKeyboard,
  },
  {
    id: 'toggleWelcome',
    group: 'Help',
    scope: 'global',
    desc: 'About / welcome',
    chords: [{ key: 'a' }],
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS_DEF)[number]['id'];

export const SHORTCUTS: readonly (Shortcut & { id: ShortcutId })[] = SHORTCUTS_DEF;

/**
 * Does this event match the chord, with no extra modifiers held?
 *
 * Shift is the one asymmetry, and deliberately so. For a printable key, shift
 * is *how the character is produced* — '?' is Shift+/, and Caps Lock shouldn't
 * stop 'T' working — so shift is ignored unless explicitly required. For a
 * named key ('ArrowLeft', 'Home') shift is a real modifier, so it must match
 * exactly; that's what keeps ← and ⇧← as separate bindings.
 */
export function matchesChord(chord: KeyChord, e: KeyboardEvent): boolean {
  const mods = chord.mods ?? [];

  // Cmd and Ctrl are the same modifier here (Mac vs everything else).
  if ((e.metaKey || e.ctrlKey) !== mods.includes('cmd')) return false;
  if (e.altKey !== mods.includes('alt')) return false;

  const printable = chord.key.length === 1;
  const wantShift = mods.includes('shift');
  if (!printable && e.shiftKey !== wantShift) return false;
  if (printable && wantShift && !e.shiftKey) return false;

  return printable
    ? e.key.toLowerCase() === chord.key.toLowerCase()
    : e.key === chord.key;
}

/** The keycaps to render for a chord, e.g. ⇧ + ←. */
export function chordCaps(chord: KeyChord): readonly KeyToken[] {
  if (chord.caps) return chord.caps;
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  return [...(chord.mods ?? []), key];
}

/**
 * Is the event target something the user is typing into? Such targets keep
 * their keystrokes.
 *
 * Note what is deliberately absent: dialog descendants. Modal focuses its own
 * card on open, so `e.target` *is* the modal card — excluding it would stop
 * `a` / `?` from closing an open dialog.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (
    target.closest(
      '[contenteditable]:not([contenteditable="false"]), [role="textbox"]'
    ) !== null
  );
}
