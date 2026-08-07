'use client';

import React from 'react';
import { Modal } from './Modal';
import { KeyCombo } from './Kbd';
import { SHORTCUTS, SHORTCUT_GROUPS, chordCaps } from '@/shared/shortcuts';
import type { DeviceCapabilities } from '@/hooks/useDeviceCapabilities';

interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capabilities: DeviceCapabilities;
}

/**
 * Rendered entirely from the shortcut registry, so the list can't drift from
 * the bindings — that drift is what let ⌘S go unnoticed.
 */
export function ShortcutsDialog({
  isOpen,
  onClose,
  capabilities,
}: ShortcutsDialogProps) {
  const { isApple } = capabilities;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard shortcuts">
      <dl className="shortcuts-list">
        {SHORTCUT_GROUPS.map((group) => {
          const shortcuts = SHORTCUTS.filter(
            (s) => s.group === group && (s.requires?.(capabilities) ?? true)
          );
          if (shortcuts.length === 0) return null;

          return (
            <div className="shortcuts-group" key={group}>
              <p className="shortcuts-group-title">{group}</p>
              {shortcuts.map((shortcut) => (
                <div className="shortcut-row" key={shortcut.id}>
                  <dt className="shortcut-keys">
                    {shortcut.chords.map((chord, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && (
                          <span className="shortcut-sep">{shortcut.sep ?? '/'}</span>
                        )}
                        <KeyCombo keys={chordCaps(chord)} isApple={isApple} />
                      </React.Fragment>
                    ))}
                  </dt>
                  <dd className="shortcut-desc">{shortcut.desc}</dd>
                </div>
              ))}
            </div>
          );
        })}
      </dl>
    </Modal>
  );
}
