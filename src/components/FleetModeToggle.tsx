'use client';

import type { FleetMode } from '@/shared/types';

interface FleetModeToggleProps {
  mode: FleetMode;
  onChange: (mode: FleetMode) => void;
}

const OPTIONS: { value: FleetMode; label: string; title: string }[] = [
  {
    value: 'full',
    label: 'Full history',
    title: 'Every coal unit that ever operated, including retired plants'
  },
  {
    value: 'current',
    label: "Today's fleet",
    title: 'Only units operating in the present year'
  }
];

/**
 * Header control that switches the stripe roster between the full historical
 * fleet (including retired plants) and today's operating fleet. A two-state
 * segmented control; `aria-pressed` reflects the active mode.
 */
export function FleetModeToggle({ mode, onChange }: FleetModeToggleProps) {
  return (
    <div className="opennem-fleet-toggle" role="group" aria-label="Fleet">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="opennem-fleet-toggle-option"
          aria-pressed={mode === opt.value}
          title={opt.title}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
