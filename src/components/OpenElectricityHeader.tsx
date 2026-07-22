'use client';

import Link from 'next/link';
import type { FleetMode } from '@/shared/types';
import { FleetModeToggle } from './FleetModeToggle';

interface OpenElectricityHeaderProps {
  /** Opens the welcome/help dialog. Provides a reopen affordance for touch
   *  devices that have no keyboard. */
  onOpenHelp?: () => void;
  /** Active fleet roster mode; when provided (with onFleetModeChange) the
   *  header shows the Full history / Today's fleet toggle. */
  fleetMode?: FleetMode;
  onFleetModeChange?: (mode: FleetMode) => void;
}

export function OpenElectricityHeader({ onOpenHelp, fleetMode, onFleetModeChange }: OpenElectricityHeaderProps) {
  return (
    <header className="border-b fixed top-0 left-0 right-0 z-50" style={{ backgroundColor: '#faf9f6', borderBottom: '1px solid #e5e5e5' }}>
      <div className="mx-auto px-4 py-3 lg:py-4" style={{ maxWidth: '1200px' }}>
        <div className="flex items-center justify-between">
          {/* Wordmark — this is an independent project, not an official Open
              Electricity site, so we use our own "Coal ⚡ Stripes" wordmark while
              keeping the bolt motif from the OE mark (an associated project). */}
          <Link href="/" className="opennem-brand" aria-label="Coal Stripes — home">
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
            {/* Cross-link to the generation records / stats page. */}
            <Link href="/stats" className="opennem-nav-link">
              Records
            </Link>

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
