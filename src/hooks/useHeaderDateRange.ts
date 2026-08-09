import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import {
  getHeaderDateRangeRegion,
  setHeaderDateRangeRegion,
  subscribeHeaderDateRange,
} from '@/client/header-date-range-store';

interface TrackerOptions {
  /** The `.opennem-page-head` wrapper — holds the sticky bar and the readout. */
  pageHeadRef: RefObject<HTMLDivElement | null>;
  /** The `.opennem-stripes-viz` element the region sentinels live in. */
  vizRef: RefObject<HTMLDivElement | null>;
  /** Region codes in the order they are rendered down the page. */
  regionCodes: string[];
  /**
   * Whether the page is past its loading gate and the refs above point at real
   * elements. The roster arrives one render BEFORE the dates settle, so without
   * this the effect would run against the loading spinner — refs still null —
   * and never re-run, because by then the region list has stopped changing.
   */
  ready: boolean;
}

/**
 * Watches scroll position and publishes which region header should be showing
 * the date range. Call once, from the page.
 *
 * Two observers, one for each half of the question:
 *
 * 1. *Is the page-head readout hidden?* The sticky top bar is opaque, so the
 *    readout disappears the moment its bottom edge passes the bar's bottom —
 *    which is ~50px of scroll BEFORE the first region header pins. Shrinking the
 *    observer root by the bar's height turns "hidden behind the bar" into plain
 *    non-intersection. The bar's height is measured rather than assumed because
 *    it changes at the `lg:` breakpoint.
 *
 * 2. *Which region's header is at the top?* Asked from the other end: a sticky
 *    header stays put until its own region's bottom edge shoves it off, so the
 *    topmost header on screen belongs to the first region that hasn't yet been
 *    shoved — its bottom is still more than a header's height down the page.
 *    A 1px sentinel at each region's bottom edge reports that crossing; the
 *    region itself is far too tall to ever enter or leave the viewport in one
 *    piece and would never fire on its own. `isIntersecting` alone can't tell
 *    "scrolled off the top" from "still below the fold", so the callback reads
 *    the sentinel's rect against the root's top edge.
 *
 *    Asking it from the bottom edge is what keeps it exact: measuring from
 *    region tops instead would have to model the margin between regions, and
 *    being 10px out leaves the readout in a half-clipped header — permanently,
 *    once you reach the end of the page, where the last regions share the
 *    viewport and none of their headers ever pins.
 *
 * Deliberately no React state: a region boundary would otherwise re-render the
 * page and, with it, every tile. Subscribers pull from the store instead.
 */
export function useHeaderDateRangeTracker({
  pageHeadRef,
  vizRef,
  regionCodes,
  ready,
}: TrackerOptions) {
  // Joined, so the effect re-runs when the region roster changes (a fleet-mode
  // switch adds or removes regions) but not on every render.
  const regionKey = regionCodes.join('|');

  useEffect(() => {
    const pageHead = pageHeadRef.current;
    const viz = vizRef.current;
    const codes = regionKey ? regionKey.split('|') : [];
    if (!ready || !pageHead || !viz || codes.length === 0) return;

    const bar = pageHead.querySelector('header');
    const readout = pageHead.querySelector('.opennem-stripes-header');
    const firstRegionHeader = viz.querySelector('.opennem-region-header');
    if (!bar || !readout || !firstRegionHeader) return;

    const sentinels = viz.querySelectorAll('.opennem-region-sentinel');
    // Regions whose bottom edge has passed the line — i.e. whose header has been
    // shoved off the top, or is on its way.
    const shoved = new Set<string>();
    let readoutHidden = false;

    const publish = () => {
      if (!readoutHidden) {
        setHeaderDateRangeRegion(null);
        return;
      }
      // Once every region has gone by we're in the bottom spacer; keep the
      // readout with the last one rather than dropping it.
      const topmost = codes.find(code => !shoved.has(code)) ?? codes[codes.length - 1];
      setHeaderDateRangeRegion(topmost);
    };

    // Both observers hang off a measured height, which has to be baked into
    // rootMargin and can't be updated in place — so each is rebuilt when its
    // height changes (the bar's changes at the `lg:` breakpoint, the region
    // header's on the mobile one).
    const rebuildOnResize: (() => void)[] = [];

    let regionObserver: IntersectionObserver | null = null;
    let observedHeaderHeight = -1;
    const watchRegions = () => {
      const headerHeight = Math.ceil(firstRegionHeader.getBoundingClientRect().height);
      if (headerHeight === observedHeaderHeight) return;
      observedHeaderHeight = headerHeight;
      regionObserver?.disconnect();
      regionObserver = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            const code = (entry.target as HTMLElement).dataset.regionCode;
            if (!code) continue;
            const rootTop = entry.rootBounds?.top ?? 0;
            if (entry.boundingClientRect.bottom <= rootTop) shoved.add(code);
            else shoved.delete(code);
          }
          publish();
        },
        { rootMargin: `-${headerHeight}px 0px 0px 0px`, threshold: 0 }
      );
      for (const sentinel of sentinels) regionObserver.observe(sentinel);
    };
    rebuildOnResize.push(watchRegions);

    let readoutObserver: IntersectionObserver | null = null;
    let observedBarHeight = -1;
    const watchReadout = () => {
      const barHeight = Math.ceil(bar.getBoundingClientRect().height);
      if (barHeight === observedBarHeight) return;
      observedBarHeight = barHeight;
      readoutObserver?.disconnect();
      readoutObserver = new IntersectionObserver(
        entries => {
          for (const entry of entries) readoutHidden = !entry.isIntersecting;
          publish();
        },
        { rootMargin: `-${barHeight}px 0px 0px 0px`, threshold: 0 }
      );
      readoutObserver.observe(readout);
    };
    rebuildOnResize.push(watchReadout);

    for (const rebuild of rebuildOnResize) rebuild();
    const resizeObserver = new ResizeObserver(() => {
      for (const rebuild of rebuildOnResize) rebuild();
    });
    resizeObserver.observe(bar);
    resizeObserver.observe(firstRegionHeader);

    return () => {
      regionObserver?.disconnect();
      readoutObserver?.disconnect();
      resizeObserver.disconnect();
      setHeaderDateRangeRegion(null);
    };
  }, [pageHeadRef, vizRef, regionKey, ready]);
}

/** True when this region's header is the one that should show the date range. */
export function useHeaderDateRangeSlot(regionCode: string): boolean {
  return useSyncExternalStore(
    subscribeHeaderDateRange,
    () => getHeaderDateRangeRegion() === regionCode,
    () => false
  );
}
