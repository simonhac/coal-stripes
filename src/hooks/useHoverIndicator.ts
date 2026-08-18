import { useEffect } from 'react';
import { DATE_BOUNDARIES } from '@/shared/config';

/**
 * Last known pointer position, in client coordinates.
 *
 * Shared rather than per-tile because the tiles need it when the pointer
 * *hasn't* moved — on scroll, the canvas under the cursor changes without a
 * mousemove, and the tile that just slid under the pointer has no position of
 * its own to consult.
 */
let pointerPosition: { x: number; y: number } | null = null;

/**
 * The stripe canvas under the pointer, and whether that answer is still good.
 *
 * This exists because `document.elementFromPoint` is not a cheap query — it
 * forces a synchronous style and layout flush. Every facility row used to call
 * it from its own paint effect, so a page with ~50 rows paid ~50 forced layouts
 * on every frame of a pan, to answer a question with exactly one answer: only
 * one canvas can be under the pointer.
 *
 * Caching it is sound for the *canvases* specifically. A pan changes the pixels
 * inside a canvas, never its position or size — the rows are a fixed-height
 * column of full-width elements. So the hovered canvas can only change when the
 * pointer moves, the page scrolls, the window resizes, or a row's height changes
 * as its data lands, and each of those invalidates below.
 *
 * Deliberately NOT extended to CapFacXAxis, whose month cells are the opposite
 * case: they are re-laid-out on every frame of a pan, so they really do slide
 * under a stationary pointer and really do have to be re-tested each time. It
 * keeps its own direct call, and there are six of those rather than fifty.
 */
let hoveredCanvas: HTMLCanvasElement | null = null;
let hoverStale = true;

/**
 * Tiles that want to know when they have slid under the pointer, keyed by the
 * canvas so the shared scroll listener can call back the one that matters
 * instead of waking all fifty. Replaces a per-row `window.addEventListener`.
 */
const hoverTargets = new Map<Element, () => void>();

const CANVAS_CLASS = 'opennem-facility-canvas';

function resolveHoveredCanvas(): HTMLCanvasElement | null {
  if (!hoverStale) return hoveredCanvas;
  hoverStale = false;

  if (!pointerPosition) {
    hoveredCanvas = null;
    return null;
  }

  const element = document.elementFromPoint(pointerPosition.x, pointerPosition.y);
  hoveredCanvas = element?.classList.contains(CANVAS_CLASS)
    ? (element as HTMLCanvasElement)
    : null;
  return hoveredCanvas;
}

export function getPointerPosition(): { x: number; y: number } | null {
  return pointerPosition;
}

/**
 * The stripe canvas under the pointer, or null if the pointer is elsewhere.
 *
 * Resolved at most once per invalidation no matter how many rows ask, so the
 * natural usage — every row asking "is it me?" during its paint — costs one hit
 * test for the whole page rather than one each.
 */
export function getHoveredCanvas(): HTMLCanvasElement | null {
  return resolveHoveredCanvas();
}

/**
 * Force the next getHoveredCanvas() to re-test.
 *
 * For the one invalidating event this module cannot observe: a row's canvas
 * changing height when its data arrives, which moves every row below it out from
 * under the pointer without a mousemove, a scroll or a resize. CompositeTile
 * calls this when it repaints at a new height.
 */
export function invalidateHoverTarget(): void {
  hoverStale = true;
}

/**
 * Ask to be told when this canvas comes to be under the pointer without the
 * pointer having moved. Returns an unregister function.
 */
export function registerHoverTarget(canvas: HTMLCanvasElement, onHovered: () => void): () => void {
  hoverTargets.set(canvas, onHovered);
  return () => {
    hoverTargets.delete(canvas);
  };
}

/**
 * Drives the `--hover-x` vertical hover line, tracks the pointer for the tiles,
 * and owns the single hit test the whole page shares.
 *
 * Mount this exactly once. It used to be only the mousemove listener that lived
 * here — CompositeTile kept its own copy of the hit test in its paint effect and
 * its own `scroll` listener, one of each per row. Both are now served from here:
 * the paint path reads the cached answer, and the scroll path is one listener
 * that calls back only the row that ended up under the pointer.
 *
 * The indicator stays outside React deliberately: it updates at pointer rate
 * and one inherited custom property drives every row's ::before, so a re-render
 * per move would be strictly worse than a single style write.
 */
export function useHoverIndicator(): void {
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      pointerPosition = { x: e.clientX, y: e.clientY };
      hoverStale = true;

      const canvas = resolveHoveredCanvas();
      if (!canvas) return;

      // All canvases are TILE_WIDTH px wide internally, stretched to 100%.
      const tileWidth = DATE_BOUNDARIES.TILE_WIDTH;
      const rect = canvas.getBoundingClientRect();
      const dayColumn = Math.floor(((e.clientX - rect.left) / rect.width) * tileWidth);
      if (dayColumn >= 0 && dayColumn < tileWidth) {
        const percentage = (dayColumn / tileWidth) * 100;
        document.documentElement.style.setProperty('--hover-x', `${percentage}%`);
      }
    };

    // Scrolling slides a different row under a stationary pointer. Re-test once
    // and tell only that row, which is what the ~50 per-row scroll listeners
    // this replaces were collectively working out the expensive way.
    const handleScroll = () => {
      hoverStale = true;
      const canvas = resolveHoveredCanvas();
      if (canvas) hoverTargets.get(canvas)?.();
    };

    // A resize re-lays-out everything. Nothing to notify — the next paint or
    // pointer move will ask, and it will get a fresh answer.
    const handleResize = () => {
      hoverStale = true;
    };

    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize, { passive: true });
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, []);
}
