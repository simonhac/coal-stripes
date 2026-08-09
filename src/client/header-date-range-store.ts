/**
 * Which region header, if any, should be showing the date range right now.
 *
 * The page head's date range readout scrolls away long before you have finished
 * reading the stripes, so the pinned region header borrows the slot its tooltip
 * normally occupies. Both halves of that question — "is the page-head readout
 * hidden?" and "which region is pinned?" — are answered by scroll position, and
 * neither belongs in React state: routing them through `Home` would re-render
 * every tile on a region boundary. They land here instead, and only the six
 * `RegionTooltip` leaves subscribe.
 *
 * `currentRegionCode` is non-null only when the page-head readout is hidden, so
 * a subscriber's whole question is `code === currentRegionCode`.
 */

let currentRegionCode: string | null = null;
const listeners = new Set<() => void>();

export function subscribeHeaderDateRange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHeaderDateRangeRegion(): string | null {
  return currentRegionCode;
}

export function setHeaderDateRangeRegion(regionCode: string | null): void {
  if (regionCode === currentRegionCode) return;
  currentRegionCode = regionCode;
  for (const listener of listeners) listener();
}
