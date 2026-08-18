/**
 * One facility's stripe row: a canvas showing the trailing 365-day window of
 * daily capacity factors, one pixel column per day.
 *
 * Rendering approach: each calendar year of data is pre-rendered once into an
 * offscreen canvas (FacilityYearTile, one pixel per day per unit). This
 * component just RESLICES those pre-rendered tiles — it copies the visible
 * portion of the current year (and, when the window straddles New Year, the
 * adjacent year) into a fixed 365px-wide canvas that CSS stretches to fit.
 * That makes drag/wheel navigation a pair of cheap drawImage calls per frame
 * rather than a repaint of thousands of day-cells.
 *
 * While a year's data is still loading, the pending region gets an animated
 * shimmer; a year outside the available range renders as the pale blue
 * "no data" colour.
 */
import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { FacilityYearTile } from '@/client/facility-year-tile';
import { leadingBackgroundDays } from '@/client/cap-fac-year';
import { getDayIndex, isLeapYear, getDaysBetween, getDateFromIndex } from '@/shared/date-utils';
import { yearQueryOptions, isValidYear } from '@/client/year-queries';
import { formatUnitName } from '@/client/unit-names';
import { useFleetMode } from '@/client/fleet-mode-context';
import { perfMonitor } from '@/shared/performance-monitor';
import { emitTooltip, endTooltip } from '@/client/tooltip-bus';
import { useTouchAsHover } from '@/hooks/useTouchAsHover';
import { getPointerPosition } from '@/hooks/useHoverIndicator';
import { featureFlags } from '@/shared/feature-flags';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { tileMonitor } from '@/shared/tile-monitor';
import { DATE_BOUNDARIES, PAGE_BACKGROUND_HEX } from '@/shared/config';

interface CompositeTileProps {
  endDate: CalendarDate;
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  animatedDateRange?: { start: CalendarDate; end: CalendarDate };
  minCanvasHeight?: number;
  /**
   * The row's height before any tile has been built, from the cached roster
   * (see roster-snapshot). Only load-bearing on a reload, where rows now render
   * ahead of their data; without it every row would start at the 12px default
   * and jump to its real 25–96px when the tiles landed.
   */
  fallbackHeight?: number;
}

type TileState = 'hasData' | 'pendingData' | 'error' | 'idle';

// Helper function to get days in a year
function getDaysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

const CompositeTileComponent = ({
  endDate,
  facilityCode,
  facilityName,
  regionCode,
  animatedDateRange,
  minCanvasHeight = 20,
  fallbackHeight
}: CompositeTileProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Seeded from the cached roster when there is one, so a row that renders
  // before its tiles exist is already the right height. 12 is the last resort.
  const lastKnownHeightRef = useRef<number>(fallbackHeight ?? 12);
  const animationFrameRef = useRef<number | null>(null);
  const lastRenderRef = useRef<{
    startStr: string;
    endStr: string;
    leftState: TileState;
    rightState: TileState;
    left: FacilityYearTile | null;
    right: FacilityYearTile | null;
  } | null>(null);
  const shimmerOffsetRef = useRef<number>(0);
  const lastAnimationTimeRef = useRef<number>(performance.now());
  const lastLoggedOffsetRef = useRef<number | null>(null);
  const sameOffsetCountRef = useRef<number>(0);
  const loggingSuppressedRef = useRef<boolean>(false);
  
  // Mouse position tracking for tooltip updates during scrolling
  
  // Use provided animated date range, or calculate from endDate
  const dateRange = useMemo(() => {
    return animatedDateRange || {
      start: endDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }), // TILE_WIDTH days total (inclusive)
      end: endDate
    };
  }, [animatedDateRange, endDate]);
  
  // Calculate which tiles we need synchronously
  const mode = useFleetMode();
  const queryClient = useQueryClient();
  const startYear = dateRange.start.year;
  const endYear = dateRange.end.year;
  const rightNeeded = startYear !== endYear;
  const leftValid = isValidYear(startYear);
  const rightValid = isValidYear(endYear);

  // Subscribe to the year queries. A cached year resolves synchronously on
  // render (so the tile appears on the first frame it's needed); an uncached
  // year triggers a fetch and reports isPending, which drives the shimmer.
  // notifyOnChangeProps keeps background refetch bookkeeping (fetchStatus)
  // from re-rendering every facility row.
  const [leftResult, rightResult] = useQueries({
    queries: [
      {
        ...yearQueryOptions(queryClient, mode, startYear),
        enabled: leftValid,
        notifyOnChangeProps: ['data', 'status'] as const,
      },
      {
        ...yearQueryOptions(queryClient, mode, endYear),
        enabled: rightNeeded && rightValid,
        notifyOnChangeProps: ['data', 'status'] as const,
      },
    ],
  });

  // Map query results onto the tile states the render logic consumes:
  // out-of-bounds years and fetch failures render as 'error' (pale blue),
  // in-flight years as 'pendingData' (shimmer). Memoised on the stable
  // data/isError fields — useQueries returns fresh result objects each
  // render, and this component re-renders every frame during gestures.
  const leftData = leftResult.data;
  const leftIsError = leftResult.isError;
  const rightData = rightResult.data;
  const rightIsError = rightResult.isError;

  const tiles = useMemo(() => {
    const resolve = (
      valid: boolean,
      data: { facilityTiles: Map<string, FacilityYearTile> } | undefined,
      isError: boolean
    ): { tile: FacilityYearTile | null; state: TileState } => {
      if (!valid || isError) return { tile: null, state: 'error' };
      if (!data) return { tile: null, state: 'pendingData' };
      const tile = data.facilityTiles.get(facilityCode);
      return tile ? { tile, state: 'hasData' } : { tile: null, state: 'error' };
    };

    const left = resolve(leftValid, leftData, leftIsError);
    const right = rightNeeded
      ? resolve(rightValid, rightData, rightIsError)
      : { tile: null, state: 'idle' as TileState };

    // The "no data" frontier: the last day with actual data. Trailing days
    // after it (reporting lag + future) are painted the page background in
    // render(). Only the latest data year carries a real frontier — a year-end
    // collection gap in an older year is an interior gap (data resumes next
    // year), not the end of the chart, so it stays blue.
    const boundaries = getDateBoundaries();
    const frontierDateFor = (year: number, data: typeof leftData): CalendarDate | null => {
      if (!data || year !== boundaries.latestDataYear) return null;
      const idx = data.regionLastDataDayIndex.get(regionCode) ?? -1;
      if (idx < 0 || idx >= getDaysInYear(year) - 1) return null;
      return getDateFromIndex(year, idx);
    };

    // The mirror of the frontier: the first day this region has data, before
    // which the row is not "missing" but "not yet begun", and so fades to the
    // page background rather than reading as a hole in the record.
    //
    // The start year wins when it has any data, exactly as CapFacXAxis does for
    // the month strip — the two overlays have to agree on where a region's
    // record starts, or the axis fades while the stripes above it stay blue.
    const regionStartFor = (year: number, data: typeof leftData): CalendarDate | null => {
      if (!data) return null;
      const idx = data.regionFirstDataDayIndex.get(regionCode) ?? -1;
      if (idx < 0) return null;
      return getDateFromIndex(year, idx);
    };

    // This region's first/last data day per year, so render() can tell whether
    // the region has any data at all in the visible window (→ fade the whole row
    // to the page background) vs an interior gap (→ pale blue).
    const boundsFor = (data: typeof leftData) => ({
      first: data?.regionFirstDataDayIndex.get(regionCode) ?? -1,
      last: data?.regionLastDataDayIndex.get(regionCode) ?? -1,
    });

    return {
      left: left.tile,
      right: right.tile,
      leftState: left.state,
      rightState: right.state,
      leftFrontierDate: frontierDateFor(startYear, leftData),
      rightFrontierDate: rightNeeded ? frontierDateFor(endYear, rightData) : null,
      leftRegionStart: regionStartFor(startYear, leftData),
      rightRegionStart: rightNeeded ? regionStartFor(endYear, rightData) : null,
      leftBounds: boundsFor(leftData),
      rightBounds: boundsFor(rightData),
    };
  }, [facilityCode, regionCode, startYear, endYear, leftValid, rightValid, rightNeeded, leftData, leftIsError, rightData, rightIsError]);

  // The row's height, resolved during RENDER rather than in the paint effect
  // below — this is load-bearing for CLS, not tidiness.
  //
  // A <canvas> with no width/height attributes has intrinsic dimensions of
  // 300×150, and CSS derives an aspect ratio from them. With `width: 100%` and
  // no height, the first painted frame laid every row out at half the container
  // width — ~584 px instead of the 25–96 px a facility actually needs. The
  // effect then corrected it one frame later, collapsing the page from ~17,600
  // px to ~1,900 px in a single reflow: CLS 0.57 on its own, all of the
  // measured score.
  //
  // Everything needed is available synchronously: `tiles` is a useMemo, so a
  // row whose year is already loaded knows its real height on the very first
  // frame. A row that renders *ahead* of its data — which is now the normal case
  // on a reload — takes `fallbackHeight` from the cached roster instead, which
  // is the same canvas height, recorded on the previous visit. Losing that
  // would reintroduce the reflow described above, one row at a time.
  const canvasHeight =
    tiles.left?.getCanvas().height ??
    tiles.right?.getCanvas().height ??
    lastKnownHeightRef.current;
  const displayHeight = Math.max(canvasHeight, minCanvasHeight);

  const drawErrorState = (ctx: CanvasRenderingContext2D, left: number, width: number, height: number) => {
    // Use light blue color to indicate unavailable data
    ctx.fillStyle = '#e6f3ff';
    ctx.fillRect(left, 0, width, height);
  };

  // Helper to convert client coordinates to canvas coordinates
  const clientToCanvasCoordinates = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { canvasX: 0, canvasY: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    // Since CSS is stretching the canvas, convert screen coordinates back to canvas coordinates
    const canvasX = (x / rect.width) * canvas.width;
    const canvasY = (y / rect.height) * canvas.height;
    
    return { canvasX, canvasY };
  }, []);
  
  // The last (unit, day) broadcast, so an un-deduped mousemove stream doesn't
  // re-broadcast an identical payload. A day column is ~2.7 CSS px wide, so
  // roughly ten mousemoves land on each one, and every listener downstream
  // (six RegionSections, six RegionLabels, and the region stats they
  // recompute) used to run for all ten. Null means "nothing is showing", so
  // re-entering the same column after a hover-end broadcasts again.
  const lastHoverKeyRef = useRef<string | null>(null);

  // Stale once the data or the visible window moves under the cursor.
  useEffect(() => {
    lastHoverKeyRef.current = null;
  }, [tiles, dateRange]);

  const updateTooltip = useCallback((x: number, y: number) => {
    try {
      const startYear = dateRange.start.year;
      const endYear = dateRange.end.year;
    
    // Calculate left tile dimensions
    const leftStartDay = getDayIndex(dateRange.start);
    const leftEndDay = startYear === endYear 
      ? getDayIndex(dateRange.end) 
      : getDaysInYear(startYear) - 1; // 0-based index for last day of year
    const leftWidth = leftEndDay - leftStartDay + 1;
    
    // Calculate total width of the composite tile
    const totalWidth = startYear === endYear ? leftWidth : leftWidth + getDayIndex(dateRange.end) + 1;
    
    // Clamp x coordinate to valid range
    const clampedX = Math.max(0, Math.min(x, totalWidth - 1));
    
    let tooltipData = null;
    
    if (clampedX < leftWidth) {
      // Mouse is in left tile
      if (tiles.left) {
        const tileX = clampedX + leftStartDay;
        tooltipData = tiles.left.getTooltipData(tileX, y);
      }
    } else if (startYear !== endYear) {
      // Mouse is in right tile
      if (tiles.right) {
        const tileX = clampedX - leftWidth;
        tooltipData = tiles.right.getTooltipData(tileX, y);
      }
    }
    
    if (tooltipData) {
      // Same unit, same day → byte-identical payload, so nothing downstream
      // can tell that we skipped it.
      const hoverKey = `${tooltipData.unitName}|${tooltipData.startDate?.toString() ?? ''}|${tooltipData.tooltipType}`;
      if (hoverKey === lastHoverKeyRef.current) return;
      lastHoverKeyRef.current = hoverKey;

      // WEM DUIDs carry the station as a prefix; drop it for display.
      const unitName = tooltipData.unitName
        ? formatUnitName(tooltipData.unitName, tooltipData.network)
        : tooltipData.unitName;
      if (unitName !== tooltipData.unitName) {
        tooltipData.label = `${facilityName} ${unitName}`;
      }
      
      // Report to tile monitor (TooltipData exposes startDate + capacityFactor)
      const tooltipDate = tooltipData.startDate;
      const tooltipValue = tooltipData.capacityFactor;
      
      if (tooltipDate) {
        // Calculate day offset from earliestDataEndDay (offset 0 = first valid end date)
        const boundaries = getDateBoundaries();
        const dayOffset = getDaysBetween(boundaries.earliestDataEndDay, tooltipDate);
        
        tileMonitor.updateMousePosition(
          dayOffset,
          tooltipDate.toString(),
          facilityName,
          unitName || tooltipData.unitName || null,
          tooltipValue
        );
      } else {
        // We have tooltip data but no date - still update with what we have
        tileMonitor.updateMousePosition(
          null,
          null,
          facilityName,
          unitName || tooltipData.unitName || null,
          tooltipValue
        );
      }
      
      // Broadcast the resolved day. Unlike a region or facility period, a day is
      // resolved by the cursor, so the value travels with it.
      emitTooltip(tooltipData);
    } else {
      // Clear mouse position when no tooltip
      lastHoverKeyRef.current = null;
      tileMonitor.clearMousePosition();
    }
    } catch (error) {
      console.error(`Error in CompositeTile updateTooltip for ${facilityCode}:`, error);
    }
  }, [dateRange, tiles, facilityName, facilityCode]);

  useEffect(() => {
    const startStr = dateRange.start.toString();
    const endStr = dateRange.end.toString();

    // Check if tiles need loading/shimmer
    const tilesNeedShimmer = tiles.leftState === 'pendingData' ||
                            (dateRange.start.year !== dateRange.end.year && tiles.rightState === 'pendingData');

    // Skip the repaint only when NOTHING that affects the painted output has
    // changed since the last paint AND we don't need to keep a shimmer running.
    // The signature must include each tile's identity, not just the date range:
    // keying on the range alone stranded a freshly-arrived tile — when the
    // second year of a two-year window loaded AFTER the first paint, the range
    // was unchanged so the guard skipped the repaint and that half stayed grey.
    // Tile identity (not just state) matters because structuralSharing:false
    // (see year-queries) yields a brand-new FacilityYearTile on refetch, so
    // 'hasData' alone can't detect a data change.
    const last = lastRenderRef.current;
    const unchanged =
      last !== null &&
      last.startStr === startStr &&
      last.endStr === endStr &&
      last.leftState === tiles.leftState &&
      last.rightState === tiles.rightState &&
      last.left === tiles.left &&
      last.right === tiles.right;

    if (unchanged && !tilesNeedShimmer) {
      return;
    }

    // Only update the ref after we've decided to render
    lastRenderRef.current = {
      startStr,
      endStr,
      leftState: tiles.leftState,
      rightState: tiles.rightState,
      left: tiles.left,
      right: tiles.right,
    };
    
    const perfName = 'CompositeTile.render';
    perfMonitor.start(perfName);
    
    const canvas = canvasRef.current;
    if (!canvas) {
      perfMonitor.end(perfName);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      perfMonitor.end(perfName);
      return;
    }

    // Disable image smoothing for crisp pixel rendering
    ctx.imageSmoothingEnabled = false;
    // @ts-ignore - vendor prefixes for older browsers
    ctx.mozImageSmoothingEnabled = false;
    // @ts-ignore - vendor prefixes for older browsers
    ctx.webkitImageSmoothingEnabled = false;
    // @ts-ignore - vendor prefixes for older browsers
    ctx.msImageSmoothingEnabled = false;
    
    // Cancel any existing animation
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // Remember the height for the next render that has no tile to measure, so a
    // row that briefly loses its data keeps its size instead of collapsing.
    // canvasHeight/displayHeight themselves are computed during render (above)
    // and applied as JSX attributes; assigning them again here would only clear
    // the canvas redundantly.
    if (tiles.left || tiles.right) {
      lastKnownHeightRef.current = canvasHeight;
    }

    // Clear before repainting. React has already set width/height to the same
    // values, but drawImage does not clear, and re-assigning width does — which
    // is exactly what a repaint needs. Internal resolution stays at one pixel
    // per day (TILE_WIDTH wide); CSS stretches it to fit.
    canvas.width = DATE_BOUNDARIES.TILE_WIDTH;
    canvas.height = canvasHeight;

    // Use date range
    const startYear = dateRange.start.year;
    const endYear = dateRange.end.year;
    
    // Update tooltip if mouse is hovering during date range changes
    const mousePos = getPointerPosition();
    if (mousePos && canvasRef.current) {
      const elementAtMouse = document.elementFromPoint(mousePos.x, mousePos.y);
      if (elementAtMouse === canvasRef.current) {
        const { canvasX, canvasY } = clientToCanvasCoordinates(mousePos.x, mousePos.y);
        updateTooltip(canvasX, canvasY);
      }
    }
    
    
    // Calculate dimensions (in source pixels - always 365 total)
    const leftStartDay = getDayIndex(dateRange.start);
    const leftEndDay = startYear === endYear 
      ? getDayIndex(dateRange.end) 
      : getDaysInYear(startYear) - 1; // 0-based index for last day of year
    const leftWidth = leftEndDay - leftStartDay + 1;
    
    const rightWidth = startYear !== endYear ? getDayIndex(dateRange.end) + 1 : 0;
    
    // Ensure total width is exactly TILE_WIDTH days
    const totalDays = leftWidth + rightWidth;
    if (totalDays !== DATE_BOUNDARIES.TILE_WIDTH) {
      console.warn(`[${facilityCode}] Width mismatch! leftWidth: ${leftWidth}, rightWidth: ${rightWidth}, total: ${totalDays}, dateRange: ${dateRange.start} to ${dateRange.end}`);
    }
    
    
    // Check if we need shimmer animation
    const needsShimmer = tiles.leftState === 'pendingData' || (startYear !== endYear && tiles.rightState === 'pendingData');
    
    // Helper function to log paint events with shimmer suppression
    const logPaintEvent = (offset: number, overstep: number | null) => {
      // Only log for Bayswater to reduce noise
      if (facilityCode !== 'BAYSW' || !featureFlags.get('gestureLogging')) {
        return;
      }
      
      // Check if this is a repeated shimmer at the same offset
      if (offset === lastLoggedOffsetRef.current && needsShimmer) {
        sameOffsetCountRef.current++;
        
        // After 10 identical shimmer paints, suppress logging
        if (sameOffsetCountRef.current === 10) {
          console.log('🎨 PAINT:  shimmering... will disable debug logging until a change in offset');
          loggingSuppressedRef.current = true;
        }
      } else {
        // Offset changed, reset counters and re-enable logging
        if (loggingSuppressedRef.current) {
          loggingSuppressedRef.current = false;
        }
        lastLoggedOffsetRef.current = offset;
        sameOffsetCountRef.current = 0;
      }
      
      // Only log if not suppressed
      if (!loggingSuppressedRef.current) {
        console.log('🎨 PAINT: ', {
          offset,
          range: `${dateRange.start.toString()} to ${dateRange.end.toString()}`,
          overstep,
          ts: Date.now()
        });
      }
    };
    
    const render = () => {
      // Log and report tile state (offset from earliestDataEndDay, 0 = first valid end date)
      const boundaries = getDateBoundaries();
      const offset = getDaysBetween(boundaries.earliestDataEndDay, dateRange.end);
      const overstep = boundaries.calculateOverstep(offset);
      
      // Report to tile monitor (for all tiles, not just Bayswater)
      tileMonitor.updateTileState(offset, overstep, dateRange.start, dateRange.end);
      
      // Log paint events with shimmer suppression
      logPaintEvent(offset, overstep);

      // draw left tile
      if (tiles.leftState === 'hasData' && tiles.left) {
        const sourceCanvas = tiles.left.getCanvas();
        ctx.drawImage(
          sourceCanvas,
          leftStartDay, 0, leftWidth, sourceCanvas.height,
          0, 0, leftWidth, sourceCanvas.height
        );
      } else if (tiles.leftState === 'error') {
        drawErrorState(ctx, 0, leftWidth, canvas.height);
      }
            
      // draw right tile if we're spanning two years
      if (startYear !== endYear) {
        if (tiles.rightState === 'hasData' && tiles.right) {
          const sourceCanvas = tiles.right.getCanvas();
          ctx.drawImage(
            sourceCanvas,
            0, 0, rightWidth, sourceCanvas.height,
            leftWidth, 0, rightWidth, sourceCanvas.height
          );
        } else if (tiles.rightState === 'error') {
          drawErrorState(ctx, leftWidth, rightWidth, canvas.height);
        }
      }
      
      
      // Draw shimmer overlay if needed
      if (needsShimmer) {
        // Calculate shimmer region
        let shimmerX = 0;
        let shimmerWidth = 0;
        
        if (tiles.leftState === 'pendingData' && (!startYear || startYear === endYear || tiles.rightState !== 'pendingData')) {
          // Only left is pending
          shimmerX = 0;
          shimmerWidth = leftWidth;
        } else if (startYear !== endYear && tiles.rightState === 'pendingData' && tiles.leftState !== 'pendingData') {
          // Only right is pending
          shimmerX = leftWidth;
          shimmerWidth = rightWidth;
        } else if (tiles.leftState === 'pendingData' && tiles.rightState === 'pendingData') {
          // Both are pending - single shimmer across both
          shimmerX = 0;
          shimmerWidth = leftWidth + rightWidth;
        }
        
        if (shimmerWidth > 0) {
          // Update shimmer offset
          const now = performance.now();
          const delta = now - lastAnimationTimeRef.current;
          lastAnimationTimeRef.current = now;
          // Sweep at 0.2 canvas-px per ms (~1.8s to cross a full-width region)
          shimmerOffsetRef.current = (shimmerOffsetRef.current + delta * 0.2) % (shimmerWidth * 2);

          // Fill base colour (slightly darker for more contrast)
          ctx.fillStyle = '#e0e0e0';
          ctx.fillRect(shimmerX, 0, shimmerWidth, canvas.height);

          // Draw a soft white highlight band, 40% of the region wide
          const gradientWidth = shimmerWidth * 0.4;
          const gradientX = shimmerX + shimmerOffsetRef.current - gradientWidth;

          const gradient = ctx.createLinearGradient(gradientX, 0, gradientX + gradientWidth, 0);
          gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.6)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
          
          ctx.save();
          ctx.fillStyle = gradient;
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillRect(shimmerX, 0, shimmerWidth, canvas.height);
          ctx.restore();

        }
      }

      // Paint the page background over the parts that lie outside the available
      // data. Drawn last, so it sits above the tile and shimmer. Interior null
      // days are left as their baked-in pale blue "no data" colour.
      ctx.fillStyle = PAGE_BACKGROUND_HEX;

      // A region with no data anywhere in the visible window (e.g. WEM before its
      // coal data begins) fades entirely to the page background — like the
      // chart's empty ends — rather than a solid block of pale blue.
      const startDayIdx = getDayIndex(dateRange.start);
      const endDayIdx = getDayIndex(dateRange.end);
      let regionEmpty = false;
      if (startYear === endYear) {
        if (tiles.leftState === 'hasData') {
          const { first, last } = tiles.leftBounds;
          regionEmpty = !(last >= 0 && last >= startDayIdx && first <= endDayIdx);
        }
      } else {
        const startHas = tiles.leftState === 'hasData' &&
          tiles.leftBounds.last >= 0 && tiles.leftBounds.last >= startDayIdx;
        const endHas = tiles.rightState === 'hasData' &&
          tiles.rightBounds.first >= 0 && tiles.rightBounds.first <= endDayIdx;
        // Only conclude "empty" once both spanned years have loaded; while one is
        // still pending, leave the shimmer/normal render in place.
        if (!startHas && !endHas && tiles.leftState === 'hasData' && tiles.rightState === 'hasData') {
          regionEmpty = true;
        }
      }

      if (regionEmpty) {
        ctx.fillRect(0, 0, DATE_BOUNDARIES.TILE_WIDTH, canvas.height);
      } else {
        // Trailing region after the data frontier (reporting lag + future)…
        const frontierDate = tiles.rightFrontierDate ?? tiles.leftFrontierDate;
        if (frontierDate) {
          const startIdx = Math.max(0, Math.min(
            getDaysBetween(dateRange.start, frontierDate) + 1,
            DATE_BOUNDARIES.TILE_WIDTH
          ));
          if (startIdx < DATE_BOUNDARIES.TILE_WIDTH) {
            ctx.fillRect(startIdx, 0, DATE_BOUNDARIES.TILE_WIDTH - startIdx, canvas.height);
          }
        }
        // …and the leading region, before the record begins — the global
        // earliest day OR this region's first data day, whichever is later. See
        // leadingBackgroundDays for why the region bound is load-bearing.
        const preDataEndIdx = leadingBackgroundDays(
          dateRange.start,
          boundaries.earliestDataDay,
          tiles.leftRegionStart ?? tiles.rightRegionStart,
          DATE_BOUNDARIES.TILE_WIDTH,
        );
        if (preDataEndIdx > 0) {
          ctx.fillRect(0, 0, preDataEndIdx, canvas.height);
        }
      }

      // Continue shimmer animation if needed
      if (needsShimmer) {
        animationFrameRef.current = requestAnimationFrame(render);
      }
    };
    
    render();
    perfMonitor.end(perfName);
    
    // Cleanup
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [dateRange, tiles, facilityCode, updateTooltip, canvasHeight, clientToCanvasCoordinates]);
  
  // Mouse handlers for hover only
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { canvasX, canvasY } = clientToCanvasCoordinates(e.clientX, e.clientY);
    updateTooltip(canvasX, canvasY);
  }, [clientToCanvasCoordinates, updateTooltip]);
  
  // Pointer tracking and the --hover-x indicator are hoisted into a single
  // app-level useHoverIndicator() — see that hook for why.

  // Handle window scroll to update tooltip
  useEffect(() => {
    const handleScroll = () => {
      const mousePos = getPointerPosition();
      if (!canvasRef.current || !mousePos) return;

      // Get element at current mouse position
      const elementAtMouse = document.elementFromPoint(mousePos.x, mousePos.y);

      // Check if it's our canvas
      if (elementAtMouse === canvasRef.current) {
        const { canvasX, canvasY } = clientToCanvasCoordinates(mousePos.x, mousePos.y);
        updateTooltip(canvasX, canvasY);
      } else {
        // Mouse not over our canvas - check if we need to call onHoverEnd
        // We can check if the tooltip is currently showing for this tile
        // Note: We don't have a way to know if tooltip was showing for this specific tile
        // The parent component manages tooltip state across all tiles
      }
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [updateTooltip, facilityCode, clientToCanvasCoordinates]);

  // Shared by mouse-leave and touch-end: drop the hover indicator, tell the
  // perf overlay, and arm the dedupe so the next entry always broadcasts.
  const endHover = useCallback(() => {
    lastHoverKeyRef.current = null;
    document.documentElement.style.removeProperty('--hover-x');
    tileMonitor.clearMousePosition();
    endTooltip();
  }, []);

  // Touch handlers for hover functionality
  const touchHandlers = useTouchAsHover({
    onHoverStart: (clientX, clientY) => {
      const { canvasX, canvasY } = clientToCanvasCoordinates(clientX, clientY);
      updateTooltip(canvasX, canvasY);
    },
    onHoverMove: (clientX, clientY) => {
      const { canvasX, canvasY } = clientToCanvasCoordinates(clientX, clientY);
      updateTooltip(canvasX, canvasY);
    },
    onHoverEnd: endHover,
  });

  return (
    <div className="opennem-stripe-data">
      <canvas
        ref={canvasRef}
        className="opennem-facility-canvas"
        width={DATE_BOUNDARIES.TILE_WIDTH}
        height={canvasHeight}
        style={{
          width: '100%',
          height: `${displayHeight}px`,
          imageRendering: 'pixelated'
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={endHover}
        {...touchHandlers}
      />
    </div>
  );
};

CompositeTileComponent.displayName = 'CompositeTile';

export const CompositeTile = React.memo(CompositeTileComponent);