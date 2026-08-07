import {
  SHORTCUTS,
  chordCaps,
  matchesChord,
  type KeyChord,
  type ShortcutId,
} from '../shortcuts';

// The unit suite runs in `node`, so KeyboardEvent isn't available. matchesChord
// only reads five fields, so a plain object stands in for the real event.
function keyEvent(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as KeyboardEvent;
}

function chordsFor(id: ShortcutId): readonly KeyChord[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id);
  if (!shortcut) throw new Error(`No shortcut ${id}`);
  return shortcut.chords;
}

/** Does any chord of this shortcut match? (What the listener actually asks.) */
function fires(id: ShortcutId, e: KeyboardEvent): boolean {
  return chordsFor(id).some((c) => matchesChord(c, e));
}

describe('matchesChord', () => {
  describe('modifiers must match exactly', () => {
    // The regression this whole registry exists for: ⌘S used to preventDefault
    // and fling the timeline to 1999 instead of saving the page.
    it('does not fire "start of data" for Cmd+S or Ctrl+S', () => {
      expect(fires('toStart', keyEvent('s'))).toBe(true);
      expect(fires('toStart', keyEvent('s', { meta: true }))).toBe(false);
      expect(fires('toStart', keyEvent('s', { ctrl: true }))).toBe(false);
    });

    it('does not fire "latest data" for Cmd+T or Ctrl+T', () => {
      expect(fires('toLatest', keyEvent('t'))).toBe(true);
      expect(fires('toLatest', keyEvent('t', { meta: true }))).toBe(false);
      expect(fires('toLatest', keyEvent('t', { ctrl: true }))).toBe(false);
      expect(fires('toLatest', keyEvent('Home'))).toBe(true);
      expect(fires('toLatest', keyEvent('Home', { meta: true }))).toBe(false);
    });

    // Alt+Left is Back in Chrome/Firefox on Windows and Linux.
    it('leaves Alt+Arrow to the browser', () => {
      expect(fires('stepMonth', keyEvent('ArrowLeft'))).toBe(true);
      expect(fires('stepMonth', keyEvent('ArrowLeft', { alt: true }))).toBe(false);
      expect(fires('yearBoundary', keyEvent('ArrowLeft', { meta: true, alt: true }))).toBe(false);
    });

    it('does not treat Cmd+Shift+Arrow as Cmd+Arrow', () => {
      expect(fires('yearBoundary', keyEvent('ArrowLeft', { meta: true }))).toBe(true);
      expect(fires('yearBoundary', keyEvent('ArrowLeft', { meta: true, shift: true }))).toBe(false);
    });

    it('treats Cmd and Ctrl as the same modifier', () => {
      expect(fires('yearBoundary', keyEvent('ArrowRight', { meta: true }))).toBe(true);
      expect(fires('yearBoundary', keyEvent('ArrowRight', { ctrl: true }))).toBe(true);
    });
  });

  describe('shift', () => {
    it('is significant for named keys, so arrows stay three distinct bindings', () => {
      const bare = keyEvent('ArrowLeft');
      const shifted = keyEvent('ArrowLeft', { shift: true });

      expect(fires('stepMonth', bare)).toBe(true);
      expect(fires('stepMonth', shifted)).toBe(false);
      expect(fires('stepSixMonths', shifted)).toBe(true);
      expect(fires('stepSixMonths', bare)).toBe(false);
    });

    // Shift is how '?' and an uppercase 'T' are produced in the first place.
    it('is ignored for printable keys', () => {
      expect(fires('toggleShortcuts', keyEvent('?', { shift: true }))).toBe(true);
      expect(fires('toggleShortcuts', keyEvent('?'))).toBe(true);
      expect(fires('toLatest', keyEvent('T', { shift: true }))).toBe(true);
      expect(fires('toLatest', keyEvent('T'))).toBe(true);
    });
  });

  it('carries the direction argument that distinguishes left from right', () => {
    const [left, right] = chordsFor('stepSixMonths');
    expect(left.arg).toBe(-6);
    expect(right.arg).toBe(6);
  });

  it('matches at most one shortcut for any given event', () => {
    const events = [
      keyEvent('ArrowLeft'),
      keyEvent('ArrowLeft', { shift: true }),
      keyEvent('ArrowLeft', { meta: true }),
      keyEvent('ArrowRight'),
      keyEvent('Home'),
      keyEvent('t'),
      keyEvent('s'),
      keyEvent('a'),
      keyEvent('?', { shift: true }),
    ];
    for (const e of events) {
      const matched = SHORTCUTS.filter((s) => s.chords.some((c) => matchesChord(c, e)));
      expect(matched).toHaveLength(1);
    }
  });
});

describe('chordCaps', () => {
  it('renders modifiers before an upper-cased key', () => {
    expect(chordCaps({ key: 'ArrowLeft', mods: ['shift'] })).toEqual(['shift', 'ArrowLeft']);
    expect(chordCaps({ key: 'ArrowRight', mods: ['cmd'] })).toEqual(['cmd', 'ArrowRight']);
    expect(chordCaps({ key: 't' })).toEqual(['T']);
    expect(chordCaps({ key: '?' })).toEqual(['?']);
    expect(chordCaps({ key: 'Home' })).toEqual(['Home']);
  });

  it('honours an explicit override', () => {
    expect(chordCaps({ key: 'a', caps: ['Esc'] })).toEqual(['Esc']);
  });
});
