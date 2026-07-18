'use client';

import React from 'react';
import { Modal } from './Modal';
import { KeyCombo } from './Kbd';
import type { DeviceCapabilities } from '@/hooks/useDeviceCapabilities';

interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capabilities: DeviceCapabilities;
}

interface ShortcutRow {
  keys: React.ReactNode;
  desc: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export function ShortcutsDialog({
  isOpen,
  onClose,
  capabilities,
}: ShortcutsDialogProps) {
  const { isApple } = capabilities;

  const groups: ShortcutGroup[] = [
    {
      title: 'Navigate',
      rows: [
        {
          keys: (
            <>
              <KeyCombo keys={['ArrowLeft']} isApple={isApple} />
              <span className="shortcut-sep">/</span>
              <KeyCombo keys={['ArrowRight']} isApple={isApple} />
            </>
          ),
          desc: 'Back / forward one month',
        },
        {
          keys: (
            <>
              <KeyCombo keys={['shift', 'ArrowLeft']} isApple={isApple} />
              <span className="shortcut-sep">/</span>
              <KeyCombo keys={['shift', 'ArrowRight']} isApple={isApple} />
            </>
          ),
          desc: 'Back / forward six months',
        },
        {
          keys: (
            <>
              <KeyCombo keys={['cmd', 'ArrowLeft']} isApple={isApple} />
              <span className="shortcut-sep">/</span>
              <KeyCombo keys={['cmd', 'ArrowRight']} isApple={isApple} />
            </>
          ),
          desc: 'Jump to the previous / next year boundary',
        },
      ],
    },
    {
      title: 'Jump to',
      rows: [
        {
          keys: (
            <>
              <KeyCombo keys={['Home']} isApple={isApple} />
              <span className="shortcut-sep">or</span>
              <KeyCombo keys={['T']} isApple={isApple} />
            </>
          ),
          desc: 'Latest data (the present)',
        },
        {
          keys: <KeyCombo keys={['S']} isApple={isApple} />,
          desc: 'Start of the data',
        },
      ],
    },
    {
      title: 'Help',
      rows: [
        {
          keys: <KeyCombo keys={['?']} isApple={isApple} />,
          desc: 'Show keyboard shortcuts',
        },
        {
          keys: <KeyCombo keys={['A']} isApple={isApple} />,
          desc: 'About / welcome',
        },
      ],
    },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard shortcuts">
      <dl className="shortcuts-list">
        {groups.map((group) => (
          <div className="shortcuts-group" key={group.title}>
            <p className="shortcuts-group-title">{group.title}</p>
            {group.rows.map((row, i) => (
              <div className="shortcut-row" key={i}>
                <dt className="shortcut-keys">{row.keys}</dt>
                <dd className="shortcut-desc">{row.desc}</dd>
              </div>
            ))}
          </div>
        ))}
      </dl>
    </Modal>
  );
}
