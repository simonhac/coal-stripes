import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { facilityUrl } from '@/shared/openelectricity-links';
import { formatCapacityValue } from '@/shared/energy-format';
import { FacilityLifecycle, FacilityUnitLifecycle } from '@/client/cap-fac-stats';

interface FacilityHovercardProps {
  /** The label the card is positioned against. */
  anchor: HTMLElement | null;
  /** Owned by useHovercardTrigger, which uses it for outside-press detection. */
  cardRef: React.RefObject<HTMLDivElement | null>;
  facilityCode: string;
  facilityName: string;
  /** The facility's units, or null while the displayed year is still loading. */
  lifecycle: FacilityLifecycle | null;
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

/** Space between the label and the card. */
const GAP_PX = 4;
/** Closest the card may sit to the viewport edge. */
const MARGIN_PX = 8;
/** The card's horizontal padding, so its text lines up with the label's. */
const CARD_PADDING_PX = 10;

/**
 * Measure the label's text rather than its box: the label is a flex item
 * stretched to its row's height, and rows are as tall as the facility has
 * units, so anchoring to the box drops the card a long way below a big plant's
 * name.
 */
function anchorRect(anchor: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(anchor);
  const textRect = range.getBoundingClientRect();
  range.detach();
  return textRect.height > 0 ? textRect : anchor.getBoundingClientRect();
}

/**
 * A unit's life in years: the year it was commissioned, or the span from that
 * to the year it last generated once it has retired. An em dash where
 * OpenElectricity has no commissioning date — unknown, not zero.
 */
function lifespan(unit: FacilityUnitLifecycle): string {
  if (unit.commencedYear === null) return '—';
  return unit.retiredYear === null
    ? `${unit.commencedYear}`
    : `${unit.commencedYear}–${unit.retiredYear}`;
}

/**
 * A registered capacity with its unit set small, so "MW" reads as a qualifier
 * of the number rather than as part of it — the effect small caps would give.
 */
function Capacity({ mw }: { mw: number }) {
  return (
    <>
      {formatCapacityValue(mw)}
      <span className="capacity-unit">MW</span>
    </>
  );
}

/**
 * The card raised by hovering or long-pressing a facility name: the facility,
 * its units, and a link out to its page on Open Electricity.
 *
 * Rendered through a portal because the stripe rows clip their overflow and
 * create their own stacking contexts, which would cut an in-flow card off at
 * the row boundary. That means it is positioned in viewport coordinates from
 * the anchor's rect, flipping above or shifting left near an edge.
 */
export function FacilityHovercard({
  anchor,
  cardRef,
  facilityCode,
  facilityName,
  lifecycle,
  handlers
}: FacilityHovercardProps) {
  const [mounted, setMounted] = useState(false); // SSR-safe: portal only after mount
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!anchor || !card) return;

    const labelRect = anchorRect(anchor);
    const cardRect = card.getBoundingClientRect();

    let top = labelRect.bottom + GAP_PX;
    if (top + cardRect.height > window.innerHeight - MARGIN_PX) {
      top = Math.max(MARGIN_PX, labelRect.top - GAP_PX - cardRect.height);
    }

    let left = labelRect.left - CARD_PADDING_PX;
    if (left + cardRect.width > window.innerWidth - MARGIN_PX) {
      left = window.innerWidth - MARGIN_PX - cardRect.width;
    }
    left = Math.max(MARGIN_PX, left);

    setPosition({ top, left });
  }, [anchor, cardRef, mounted]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={cardRef}
      className="facility-hovercard"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        // Laid out but unpainted for the first frame, so it can be measured
        // before it is placed.
        visibility: position ? 'visible' : 'hidden'
      }}
      {...handlers}
    >
      <div className="facility-hovercard-name">
        {facilityName}
        {lifecycle && (
          <span className="facility-hovercard-total">
            <Capacity mw={lifecycle.totalCapacity} />
          </span>
        )}
      </div>
      {lifecycle && lifecycle.units.length > 0 && (
        <div className="facility-hovercard-units">
          {lifecycle.units.map(unit => (
            <React.Fragment key={unit.name}>
              <span>{unit.name}</span>
              <span className="facility-hovercard-unit-capacity">
                <Capacity mw={unit.capacity} />
              </span>
              <span className="facility-hovercard-unit-years">{lifespan(unit)}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      <a
        className="facility-hovercard-link"
        href={facilityUrl(facilityCode)}
        target="_blank"
        rel="noopener noreferrer"
      >
        View on Open Electricity
        {/* lucide external-link */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M15 3h6v6" />
          <path d="M10 14 21 3" />
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6" />
        </svg>
      </a>
    </div>,
    document.body
  );
}
