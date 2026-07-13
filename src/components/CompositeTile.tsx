'use client';

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
import { useQueries } from '@tanstack/react-query';
import { CalendarDate } from '@internationalized/date';
import { FacilityYearTile } from '@/client/facility-year-tile';
import { getDayIndex, isLeapYear, getDaysBetween } from '@/shared/date-utils';
import { yearQueryOptions, isValidYear } from '@/client/year-queries';
import { perfMonitor } from '@/shared/performance-monitor';
import { useTouchAsHover } from '@/hooks/useTouchAsHover';
import { featureFlags } from '@/shared/feature-flags';
import { getDateBoundaries } from '@/shared/date-boundaries';
import { tileMonitor } from '@/shared/tile-monitor';
import { DATE_BOUNDARIES } from '@/shared/config';

interface CompositeTileProps {
  endDate: CalendarDate;
  facilityCode: string;
  facilityName: string;
  regionCode: string;
  animatedDateRange?: { start: CalendarDate; end: CalendarDate };
  minCanvasHeight?: number;
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
  regionCode: _regionCode,
  animatedDateRange,
  minCanvasHeight = 20
}: CompositeTileProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastKnownHeightRef = useRef<number>(12); // Default height
  const animationFrameRef = useRef<number | null>(null);
  const lastRenderedRangeRef = useRef<string>('');
  const shimmerOffsetRef = useRef<number>(0);
  const lastAnimationTimeRef = useRef<number>(performance.now());
  const lastLoggedOffsetRef = useRef<number | null>(null);
  const sameOffsetCountRef = useRef<number>(0);
  const loggingSuppressedRef = useRef<boolean>(false);
  
  // Mouse position tracking for tooltip updates during scrolling
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  
  // Use provided animated date range, or calculate from endDate
  const dateRange = useMemo(() => {
    return animatedDateRange || {
      start: endDate.subtract({ days: DATE_BOUNDARIES.TILE_WIDTH - 1 }), // TILE_WIDTH days total (inclusive)
      end: endDate
    };
  }, [animatedDateRange, endDate]);
  
  // Calculate which tiles we need synchronously
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
        ...yearQueryOptions(startYear),
        enabled: leftValid,
        notifyOnChangeProps: ['data', 'status'] as const,
      },
      {
        ...yearQueryOptions(endYear),
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

    return {
      left: left.tile,
      right: right.tile,
      leftState: left.state,
      rightState: right.state,
    };
  }, [facilityCode, leftValid, rightValid, rightNeeded, leftData, leftIsError, rightData, rightIsError]);

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
      // Format unit name - for WA units, show only the part after underscore
      let unitName = tooltipData.unitName;
      if (tooltipData.network && tooltipData.network.toUpperCase() === 'WEM' && unitName && unitName.includes('_')) {
        unitName = unitName.split('_').pop() || unitName;
        // Update the label to use formatted unit name
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
      
      // Broadcast the tooltip data via custom event
      const event = new CustomEvent('tooltip-data-hover', { 
        detail: tooltipData
      });
      window.dispatchEvent(event);
    } else {
      // Clear mouse position when no tooltip
      tileMonitor.clearMousePosition();
    }
    } catch (error) {
      console.error(`Error in CompositeTile updateTooltip for ${facilityCode}:`, error);
    }
  }, [dateRange, tiles, facilityName, facilityCode]);

  useEffect(() => {
    const rangeKey = `${dateRange.start.toString()}-${dateRange.end.toString()}`;
    
    // Check if tiles need loading/shimmer
    const tilesNeedShimmer = tiles.leftState === 'pendingData' || 
                            (dateRange.start.year !== dateRange.end.year && tiles.rightState === 'pendingData');
    
    // Skip rendering only if:
    // 1. The date range hasn't changed AND
    // 2. We don't need shimmer animation AND  
    // 3. Tiles are already loaded (not idle)
    if (lastRenderedRangeRef.current === rangeKey && 
        !tilesNeedShimmer && 
        tiles.leftState !== 'idle' && 
        tiles.rightState !== 'idle') {
      return;
    }
    
    // Only update the ref after we've actually rendered
    lastRenderedRangeRef.current = rangeKey;
    
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

    // Set height from available tiles or use last known height
    let canvasHeight = lastKnownHeightRef.current;
    if (tiles.left) {
      canvasHeight = tiles.left.getCanvas().height;
      lastKnownHeightRef.current = canvasHeight; // Update last known height
    } else if (tiles.right) {
      canvasHeight = tiles.right.getCanvas().height;
      lastKnownHeightRef.current = canvasHeight; // Update last known height
    }
    
    // Apply minimum height if specified
    const displayHeight = Math.max(canvasHeight, minCanvasHeight);
    
    // Set canvas size - keep internal resolution at one pixel per day
    // (TILE_WIDTH wide) and let CSS stretch it
    canvas.width = DATE_BOUNDARIES.TILE_WIDTH;
    canvas.height = canvasHeight;
    canvas.style.width = '100%';
    canvas.style.height = `${displayHeight}px`;

    // Use date range
    const startYear = dateRange.start.year;
    const endYear = dateRange.end.year;
    
    // Update tooltip if mouse is hovering during date range changes
    if (mousePosRef.current && canvasRef.current) {
      const elementAtMouse = document.elementFromPoint(mousePosRef.current.x, mousePosRef.current.y);
      if (elementAtMouse === canvasRef.current) {
        const { canvasX, canvasY } = clientToCanvasCoordinates(mousePosRef.current.x, mousePosRef.current.y);
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
  }, [dateRange, tiles, facilityCode, updateTooltip, minCanvasHeight, clientToCanvasCoordinates]);
  
  // Mouse handlers for hover only
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { canvasX, canvasY } = clientToCanvasCoordinates(e.clientX, e.clientY);
    updateTooltip(canvasX, canvasY);
  }, [clientToCanvasCoordinates, updateTooltip]);
  
  // Global mouse position tracking for hover indicator
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      
      // Update hover indicator if mouse is over any canvas
      const elementAtMouse = document.elementFromPoint(e.clientX, e.clientY);
      if (elementAtMouse && elementAtMouse.classList.contains('opennem-facility-canvas')) {
        const tileWidth = DATE_BOUNDARIES.TILE_WIDTH; // all canvases are TILE_WIDTH px wide internally
        const rect = elementAtMouse.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const dayColumn = Math.floor((x / rect.width) * tileWidth);
        if (dayColumn >= 0 && dayColumn < tileWidth) {
          const percentage = (dayColumn / tileWidth) * 100;
          document.documentElement.style.setProperty('--hover-x', `${percentage}%`);
        }
      }
    };
    
    document.addEventListener('mousemove', handleGlobalMouseMove);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, []);
  
  // Handle window scroll to update tooltip
  useEffect(() => {
    const handleScroll = () => {
      if (!canvasRef.current || !mousePosRef.current) return;
      
      // Get element at current mouse position
      const elementAtMouse = document.elementFromPoint(mousePosRef.current.x, mousePosRef.current.y);
      
      // Check if it's our canvas
      if (elementAtMouse === canvasRef.current) {
        const { canvasX, canvasY } = clientToCanvasCoordinates(mousePosRef.current.x, mousePosRef.current.y);
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
    onHoverEnd: () => {
      document.documentElement.style.removeProperty('--hover-x');
      const event = new CustomEvent('tooltip-data-hover-end');
      window.dispatchEvent(event);
    }
  });

  return (
    <div className="opennem-stripe-data">
      <canvas
        ref={canvasRef}
        className="opennem-facility-canvas"
        style={{ 
          width: '100%',
          imageRendering: 'pixelated'
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          // Clear hover position on document root
          document.documentElement.style.removeProperty('--hover-x');
          
          // Clear mouse position in tile monitor
          tileMonitor.clearMousePosition();
          
          // Broadcast hover end event
          const event = new CustomEvent('tooltip-data-hover-end');
          window.dispatchEvent(event);
        }}
        {...touchHandlers}
      />
    </div>
  );
};

CompositeTileComponent.displayName = 'CompositeTile';

export const CompositeTile = React.memo(CompositeTileComponent);