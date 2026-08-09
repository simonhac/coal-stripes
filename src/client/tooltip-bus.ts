/**
 * The app-wide tooltip bus.
 *
 * One tooltip serves every region header, and it can be raised from a label, a
 * stripe canvas or a month bar anywhere on the page — so the six RegionTooltips
 * subscribe to window CustomEvents rather than taking props. This module is the
 * only place the event names live.
 */
// Type-only: this module is imported by plain-.ts code and tests, which must
// not pull a React component in behind it.
import type { TooltipSource } from '@/components/CapFacTooltip';

const HOVER = 'tooltip-data-hover';
const HOVER_END = 'tooltip-data-hover-end';

/** Raise (or replace) the tooltip. */
export function emitTooltip(source: TooltipSource): void {
  window.dispatchEvent(new CustomEvent(HOVER, { detail: source }));
}

/** Close the tooltip everywhere, and unpin whatever was pinned. */
export function endTooltip(): void {
  window.dispatchEvent(new CustomEvent(HOVER_END));
}

/** Listen for both; returns the unsubscribe. */
export function subscribeTooltip(
  onSource: (source: TooltipSource) => void,
  onEnd: () => void
): () => void {
  const handleHover = (e: Event) => {
    const detail = (e as CustomEvent).detail as TooltipSource | undefined;
    if (detail) onSource(detail);
  };

  window.addEventListener(HOVER, handleHover);
  window.addEventListener(HOVER_END, onEnd);
  return () => {
    window.removeEventListener(HOVER, handleHover);
    window.removeEventListener(HOVER_END, onEnd);
  };
}
