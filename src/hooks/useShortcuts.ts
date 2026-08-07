import { useEffect, useRef } from 'react';
import {
  SHORTCUTS,
  isTypingTarget,
  matchesChord,
  type ShortcutCapabilities,
  type ShortcutId,
  type ShortcutScope,
} from '@/shared/shortcuts';

/**
 * One handler per registered shortcut. Typed against the registry, so adding a
 * shortcut without a handler (or vice versa) is a compile error rather than a
 * binding that silently does nothing.
 */
export type ShortcutHandlers = Record<
  ShortcutId,
  (arg: number | undefined, e: KeyboardEvent) => void
>;

interface UseShortcutsOptions {
  capabilities: ShortcutCapabilities;
  /** Whether a scope is currently live — see ShortcutScope. */
  isScopeActive: (scope: ShortcutScope) => boolean;
}

/**
 * The app's only keydown listener. Everything it can do is declared in
 * SHORTCUTS, which also renders the shortcuts dialog.
 */
export function useShortcuts(
  handlers: ShortcutHandlers,
  { capabilities, isScopeActive }: UseShortcutsOptions
): void {
  // Read the callbacks through refs so a changing handler map (or a per-frame
  // re-render mid-pan) doesn't tear down and reinstall the listener.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const scopeRef = useRef(isScopeActive);
  scopeRef.current = isScopeActive;
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Mid-IME composition: the keystrokes belong to the input method.
      if (e.isComposing || e.keyCode === 229) return;
      if (isTypingTarget(e.target)) return;

      for (const shortcut of SHORTCUTS) {
        if (shortcut.requires && !shortcut.requires(capabilitiesRef.current)) {
          continue;
        }
        if (!scopeRef.current(shortcut.scope)) continue;

        const chord = shortcut.chords.find((c) => matchesChord(c, e));
        if (!chord) continue;

        e.preventDefault();
        handlersRef.current[shortcut.id](chord.arg, e);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
