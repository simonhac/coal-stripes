'use client';

import { Modal } from './Modal';
import { Kbd } from './Kbd';
import type { DeviceCapabilities } from '@/hooks/useDeviceCapabilities';

interface WelcomeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  capabilities: DeviceCapabilities;
  /** Opens the keyboard-shortcuts dialog (offered only when hasKeyboard). */
  onOpenShortcuts: () => void;
}

export function WelcomeDialog({
  isOpen,
  onClose,
  capabilities,
  onOpenShortcuts,
}: WelcomeDialogProps) {
  const { isTouch, hasKeyboard } = capabilities;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Welcome to Stripes">
      <p className="welcome-intro">
        The operational status of every generating unit at each coal power
        station in Australia, at a glance.
      </p>

      <ul className="welcome-list">
        <li>
          Each row is one generating unit; the height of its bar is proportional
          to the unit&rsquo;s capacity.
        </li>
        <li>
          One thin bar per day of the year, coloured by capacity factor:{' '}
          <span className="welcome-swatch welcome-swatch--out" /> red = out of
          service, graduating from{' '}
          <span className="welcome-swatch welcome-swatch--light" /> lightly
          loaded to <span className="welcome-swatch welcome-swatch--full" />{' '}
          fully loaded. A long run of red means the whole station is offline.
        </li>
        <li>
          {isTouch
            ? 'Tap and hold a day to see a tooltip about that unit on that day.'
            : 'Touch or hover a day to see a tooltip about that unit on that day.'}
        </li>
        <li>
          {isTouch
            ? 'Drag left or right to travel back to previous periods.'
            : 'Drag, or use two fingers on a trackpad, to travel back to previous periods.'}
        </li>
        {hasKeyboard && (
          <li>
            Press{' '}
            <button
              type="button"
              className="welcome-kbd-button"
              onClick={onOpenShortcuts}
            >
              <Kbd>?</Kbd>
            </button>{' '}
            for keyboard shortcuts.
          </li>
        )}
      </ul>

      <p className="welcome-credits">
        Built as an exploration of the{' '}
        <a
          href="https://openelectricity.org.au"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Electricity API
        </a>{' '}
        by{' '}
        <a
          href="https://twitter.com/simonahac"
          target="_blank"
          rel="noopener noreferrer"
        >
          Simon Holmes à Court
        </a>
        .
      </p>
    </Modal>
  );
}
