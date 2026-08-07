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

export function getPointerPosition(): { x: number; y: number } | null {
  return pointerPosition;
}

/**
 * Drives the `--hover-x` vertical hover line, and tracks the pointer for the
 * tiles.
 *
 * Mount this exactly once. It used to live inside CompositeTile, which meant
 * every one of the ~22 facility rows installed its own document-level
 * mousemove listener — so a single pointer move ran ~22 elementFromPoint hit
 * tests and wrote the same custom property ~22 times.
 *
 * The indicator stays outside React deliberately: it updates at pointer rate
 * and one inherited custom property drives every row's ::before, so a re-render
 * per move would be strictly worse than a single style write.
 */
export function useHoverIndicator(): void {
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      pointerPosition = { x: e.clientX, y: e.clientY };

      const elementAtMouse = document.elementFromPoint(e.clientX, e.clientY);
      if (!elementAtMouse?.classList.contains('opennem-facility-canvas')) return;

      // All canvases are TILE_WIDTH px wide internally, stretched to 100%.
      const tileWidth = DATE_BOUNDARIES.TILE_WIDTH;
      const rect = elementAtMouse.getBoundingClientRect();
      const dayColumn = Math.floor(((e.clientX - rect.left) / rect.width) * tileWidth);
      if (dayColumn >= 0 && dayColumn < tileWidth) {
        const percentage = (dayColumn / tileWidth) * 100;
        document.documentElement.style.setProperty('--hover-x', `${percentage}%`);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, []);
}
