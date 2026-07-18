import React from 'react';

// Tokens the app uses; anything else (letters, "Home", "?") renders verbatim.
export type KeyToken =
  | 'cmd'
  | 'shift'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | (string & {});

function keyLabel(token: KeyToken, isApple: boolean): string {
  switch (token) {
    case 'cmd':
      return isApple ? '⌘' : 'Ctrl'; // ⌘ vs Ctrl
    case 'shift':
      return '⇧'; // ⇧
    case 'ArrowLeft':
      return '←'; // ←
    case 'ArrowRight':
      return '→'; // →
    case 'ArrowUp':
      return '↑'; // ↑
    case 'ArrowDown':
      return '↓'; // ↓
    default:
      return token; // Home, A, T, S, ?, …
  }
}

/** A single keycap. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

interface KeyComboProps {
  /** Tokens in order, e.g. ['cmd', 'ArrowLeft'] → ⌘ + ← */
  keys: KeyToken[];
  isApple: boolean;
}

/** A sequence of keycaps joined with "+" (e.g. ⇧ + ←). */
export function KeyCombo({ keys, isApple }: KeyComboProps) {
  return (
    <span className="key-combo">
      {keys.map((k, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span className="key-combo-plus" aria-hidden="true">
              +
            </span>
          )}
          <Kbd>{keyLabel(k, isApple)}</Kbd>
        </React.Fragment>
      ))}
    </span>
  );
}
