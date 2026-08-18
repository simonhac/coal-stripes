import { Link } from '@tanstack/react-router';
import type { FleetMode } from '@/shared/types';
import { FleetModeToggle } from './FleetModeToggle';

interface OpenElectricityHeaderProps {
  /** Opens the welcome/help dialog. Provides a reopen affordance for touch
   *  devices that have no keyboard. */
  onOpenHelp?: () => void;
  /** Active fleet roster mode; when provided (with onFleetModeChange) the
   *  header shows the All Units / Current Fleet toggle. */
  fleetMode?: FleetMode;
  onFleetModeChange?: (mode: FleetMode) => void;
}

export function OpenElectricityHeader({ onOpenHelp, fleetMode, onFleetModeChange }: OpenElectricityHeaderProps) {
  // These class names are Tailwind, themed by Open Electricity's own config —
  // which they were not until recently. They used to be hand-written look-alikes
  // living in opennem.css, because Tailwind had been added to package.json but
  // never wired into the build.
  //
  // The horizontal padding and the 1200px cap are NOT written here: they come
  // from `.opennem-header-inner`, which reads the same `--app-padding` as
  // `.opennem-stripes-container`. Those two left edges are the ones a reader
  // sees line up, and the only way to keep them together is to have one number.
  //
  // Sticky, not fixed: staying in flow is what lets the first region header push
  // this header off screen instead of sliding over it. The push comes for free
  // from the sticky containing block — `.opennem-page-head` in opennem.css ends
  // exactly where the first region begins.
  return (
    <header className="sticky top-0 z-50 border-b border-mid-warm-grey bg-light-warm-grey">
      <div className="opennem-header-inner mx-auto py-3 lg:py-4">
        <div className="flex items-center justify-between">
          {/* Wordmark — this is an independent project, not an official Open
              Electricity site, so we use our own "Coal ⚡ Stripes" wordmark while
              keeping the bolt motif from the OE mark (an associated project). */}
          <Link to="/" className="opennem-brand" aria-label="Coal Stripes — home">
            <span className="opennem-wordmark">Coal</span>
            <svg
              className="opennem-wordmark-bolt"
              viewBox="73.14 8.76 18.12 10.47"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M79.6652 8.96582L84.7408 14.0414L88.5681 10.2142L91.0647 12.7108L84.7408 19.0348L79.6652 13.9592L75.838 17.7864L73.3413 15.2897L79.6652 8.96582Z"
                fill="#A29D66"
                stroke="black"
                strokeWidth="0.2"
              />
            </svg>
            <span className="opennem-wordmark">Stripes</span>
          </Link>

          <div className="opennem-header-actions">
            {/* Fleet roster toggle — full historical fleet vs today's fleet. */}
            {fleetMode && onFleetModeChange && (
              <FleetModeToggle mode={fleetMode} onChange={onFleetModeChange} />
            )}

            {/* Help button — opens the welcome/about dialog. Works on all devices,
                including touch (which can't use the 'a'/'?' keyboard shortcuts). */}
            {onOpenHelp && (
              <button
                type="button"
                className="opennem-help-button"
                onClick={onOpenHelp}
                aria-label="About this visualisation"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
