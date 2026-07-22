import { Facility, GeneratingUnit } from '@/shared/types';
import { TILE_CONFIG, PAGE_BACKGROUND_ABGR } from '@/shared/config';
import { getDateFromIndex } from '@/shared/date-utils';
import { capacityFactorColorMap } from '@/shared/capacity-factor-color-map';
import { featureFlags } from '@/shared/feature-flags';
import { TooltipData } from '@/components/CapFacTooltip';

/** 0-based index of the last non-null day in a unit's series; -1 if all null. */
function lastDataDayIndex(data: (number | null)[]): number {
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] !== null) return i;
  }
  return -1;
}

/** 0-based index of the first non-null day in a unit's series; -1 if all null. */
function firstDataDayIndex(data: (number | null)[]): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== null) return i;
  }
  return -1;
}

/**
 * Colour (ABGR uint32) for one day of a unit, classifying "no data" by position:
 *   • before the unit's first data (not yet commissioned) or a unit with no data
 *     at all → page background (fades out, like the chart's empty ends)
 *   • after the unit's last data (shut down) → red (0%)
 *   • a null between first and last data (collection gap) → pale blue "unknown"
 *   • real data → the capacity-factor colour
 */
function unitDayColor(cf: number | null, dayIndex: number, unitFirst: number, unitLast: number): number {
  if (cf !== null) return capacityFactorColorMap.getIntColor(cf);
  if (unitLast < 0 || dayIndex < unitFirst) return PAGE_BACKGROUND_ABGR;
  if (dayIndex > unitLast) return capacityFactorColorMap.getIntColor(0);
  return capacityFactorColorMap.getIntColor(null);
}

export class FacilityYearTile {
  private facility: Facility;
  private year: number;
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private unitHeights: number[] | null = null;

  constructor(facility: Facility, year: number) {
    if (!facility) {
      throw new Error('Facility must not be null');
    }
    if (!facility.facilityCode) {
      throw new Error('Facility code must not be null');
    }
    if (!facility.units || facility.units.length === 0) {
      throw new Error('Units array must not be empty');
    }
    
    this.facility = facility;
    this.year = year;
    
    // Render the canvas immediately
    this.renderCanvas();
  }

  private calculateUnitHeights(): number[] {
    return this.facility.units.map(unit => {
      // Ensure heights are always integers to avoid fractional pixel positions
      return Math.round(unit.capacity / 30);
    });
  }

  private renderCanvas(): void {
    
    // Width is exactly the number of days
    const daysInYear = this.facility.units[0]?.history.data.length || 365;
    const width = daysInYear;
    
    const unitHeights = this.calculateUnitHeights();
    this.unitHeights = unitHeights; // Store for tooltip lookups
    const height = unitHeights.reduce((sum, h) => sum + h, 0);

    if (!this.canvas) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.canvas = new OffscreenCanvas(width, height);
      } else {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
      }
    }

    const ctx = this.canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    if (!ctx) {
      throw new Error('Failed to get 2D context');
    }
    
    // Create ImageData for direct pixel manipulation
    const imageData = ctx.createImageData(width, height);
    
    // Check if we're in a test environment with mock canvas
    let pixels: Uint32Array;
    let useDirectBuffer = true;
    try {
      pixels = new Uint32Array(imageData.data.buffer);
    } catch {
      // Fallback for test environment - use imageData directly
      useDirectBuffer = false;
      // Work directly with the Uint8ClampedArray
      pixels = new Uint32Array(0); // Dummy, won't be used
    }
    
    if (useDirectBuffer) {
      // Fill with white background (0xffffffff in ABGR)
      pixels.fill(0xffffffff);
      
      // Render units using direct pixel manipulation
      let yOffset = 0;
      this.facility.units.forEach((unit, unitIndex) => {
        const unitHeight = unitHeights[unitIndex];
        const unitFirst = firstDataDayIndex(unit.history.data);
        const unitLast = lastDataDayIndex(unit.history.data);

        for (let dayIndex = 0; dayIndex < unit.history.data.length; dayIndex++) {
          const color = unitDayColor(unit.history.data[dayIndex], dayIndex, unitFirst, unitLast);

          // Fill the column for this day
          for (let y = 0; y < unitHeight; y++) {
            const pixelIndex = (yOffset + y) * width + dayIndex;


            pixels[pixelIndex] = color;
          }
        }

        yOffset += unitHeight;
      });
    } else {
      // Fallback: work with Uint8ClampedArray directly
      const data = imageData.data;
      
      // Fill with white background
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;     // R
        data[i + 1] = 255; // G
        data[i + 2] = 255; // B
        data[i + 3] = 255; // A
      }
      
      // Render units
      let yOffset = 0;
      this.facility.units.forEach((unit, unitIndex) => {
        const unitHeight = unitHeights[unitIndex];
        const unitFirst = firstDataDayIndex(unit.history.data);
        const unitLast = lastDataDayIndex(unit.history.data);

        for (let dayIndex = 0; dayIndex < unit.history.data.length; dayIndex++) {
          const color = unitDayColor(unit.history.data[dayIndex], dayIndex, unitFirst, unitLast);

          // Extract RGBA components from the 32-bit color
          const r = color & 0xFF;
          const g = (color >> 8) & 0xFF;
          const b = (color >> 16) & 0xFF;
          const a = (color >> 24) & 0xFF;
          
          // Fill the column for this day
          for (let y = 0; y < unitHeight; y++) {
            const pixelIndex = ((yOffset + y) * width + dayIndex) * 4;
            data[pixelIndex] = r;
            data[pixelIndex + 1] = g;
            data[pixelIndex + 2] = b;
            data[pixelIndex + 3] = a;
          }
        }
        
        yOffset += unitHeight;
      });
    }
    
    // Put the image data back to canvas
    try {
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // Test environment fallback
      console.warn('Skipping putImageData in test environment');
    }
    
    // Draw debug overlay if tileDebugging feature flag is enabled
    if (featureFlags.get('tileDebugging')) {
      // Draw border using config values
      ctx.strokeStyle = TILE_CONFIG.DEBUG_BORDER_COLOR;
      ctx.lineWidth = TILE_CONFIG.DEBUG_BORDER_WIDTH;
      ctx.strokeRect(
        TILE_CONFIG.DEBUG_BORDER_WIDTH / 2,
        TILE_CONFIG.DEBUG_BORDER_WIDTH / 2,
        width - TILE_CONFIG.DEBUG_BORDER_WIDTH,
        height - TILE_CONFIG.DEBUG_BORDER_WIDTH
      );

      // Draw year text 4 times, equally spaced, 25% smaller
      ctx.fillStyle = TILE_CONFIG.DEBUG_TEXT_COLOR;
      const fontSize = Math.floor(TILE_CONFIG.DEBUG_TEXT_SIZE * 0.75);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const yearText = this.year.toString();
      const positions = [0.2, 0.4, 0.6, 0.8]; // 20%, 40%, 60%, 80% across the width
      
      positions.forEach(xPos => {
        ctx.fillText(
          yearText,
          width * xPos,
          height / 2
        );
      });
    }

  }

  /**
   * Get the pre-rendered canvas
   */
  getCanvas(): OffscreenCanvas | HTMLCanvasElement {
    return this.canvas!;
  }

  /**
   * Get tooltip data for a given x,y position within the tile
   * @param x X coordinate within the tile (0-based)
   * @param y Y coordinate within the tile (0-based)
   * @returns Tooltip data including date and capacity factor, or null if out of bounds
   */
  getTooltipData(x: number, y: number): TooltipData | null {
    // Check bounds
    if (!this.unitHeights || x < 0 || y < 0) {
      return null;
    }

    // Find which unit this y coordinate falls into
    let yOffset = 0;
    let unitIndex = -1;
    
    for (let i = 0; i < this.unitHeights.length; i++) {
      const unitHeight = this.unitHeights[i];
      if (y >= yOffset && y < yOffset + unitHeight) {
        unitIndex = i;
        break;
      }
      yOffset += unitHeight;
    }

    if (unitIndex === -1 || unitIndex >= this.facility.units.length) {
      return null;
    }

    const unit = this.facility.units[unitIndex];
    
    // x coordinate is the day index
    const dayIndex = Math.floor(x);
    
    // Check day bounds
    if (dayIndex < 0 || dayIndex >= unit.history.data.length) {
      return null;
    }

    const capacityFactor = unit.history.data[dayIndex];
    const date = getDateFromIndex(this.year, dayIndex);

    return {
      startDate: date,
      endDate: null,
      label: `${this.facility.facilityName} ${unit.unitName}`,
      capacityFactor,
      tooltipType: 'day',
      regionCode: this.facility.region || this.facility.network, // Use network as fallback for WEM
      facilityCode: this.facility.facilityCode,
      network: this.facility.network,
      unitName: unit.unitName
    };
  }

  /**
   * Get the year this tile represents
   */
  getYear(): number {
    return this.year;
  }

  /**
   * Get the number of days in this tile
   */
  getDaysCount(): number {
    return this.canvas!.width;
  }

  /**
   * Get the facility code
   */
  getFacilityCode(): string {
    return this.facility.facilityCode;
  }


  /**
   * Get the memory size of the rendered canvas in bytes
   */
  getSizeBytes(): number {
    // Canvas memory: width * height * 4 bytes per pixel (RGBA)
    return this.canvas!.width * this.canvas!.height * 4;
  }
  
  /**
   * Get the units for this facility
   */
  getUnits(): GeneratingUnit[] {
    return this.facility.units;
  }
  
  /**
   * Get the total capacity for this facility
   */
  getTotalCapacity(): number {
    return this.facility.units.reduce((sum, unit) => sum + unit.capacity, 0);
  }
}
