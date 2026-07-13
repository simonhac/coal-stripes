/**
 * Maps a daily capacity factor (0–100%, or null for "no data") to the colour
 * of one stripe-day.
 *
 * Encoding: below 25% the unit is effectively offline or barely running, so
 * it reads as a red warning stripe. From 25% up, the value maps linearly onto
 * a grey ramp — 25% is light grey, 100% is black — so a unit running flat out
 * appears as solid dark stripes and partial output as lighter shading. Null
 * (unknown) days are pale blue, deliberately distinct from both.
 *
 * All 101 colours are pre-computed once, in two forms: CSS hex strings for
 * DOM use, and 32-bit ABGR integers for writing directly into a canvas
 * ImageData buffer (little-endian RGBA bytes read as one ABGR uint32).
 */
class CapacityFactorColorMap {
  private static instance: CapacityFactorColorMap;
  private hexColors: string[] = new Array(101);
  private intColors: number[] = new Array(101);

  private constructor() {
    // Pre-compute all colors
    for (let i = 0; i <= 100; i++) {
      const color = this.computeColor(i);
      this.hexColors[i] = color.hex;
      this.intColors[i] = color.int;
    }
  }

  static getInstance(): CapacityFactorColorMap {
    if (!CapacityFactorColorMap.instance) {
      CapacityFactorColorMap.instance = new CapacityFactorColorMap();
    }
    return CapacityFactorColorMap.instance;
  }

  private computeColor(capacityFactor: number): { hex: string; int: number } {
    let r: number, g: number, b: number;
    
    if (capacityFactor < 25) {
      // Medium red for anything under 25%
      r = 210;
      g = 70;
      b = 70;
    } else {
      // Map capacity factor directly to grey scale
      // 25% -> 75% grey (light), 100% -> 0% grey (black)
      const clampedCapacity = Math.min(100, Math.max(25, capacityFactor));
      
      // Invert so that higher capacity = darker (lower grey value)
      const greyValue = Math.round(255 * (1 - clampedCapacity / 100));
      r = g = b = greyValue;
    }
    
    // Convert to hex format
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    
    return {
      hex: `#${toHex(r)}${toHex(g)}${toHex(b)}`,
      int: (255 << 24) | (b << 16) | (g << 8) | r
    };
  }

  getHexColor(capacityFactor: number | null): string {
    // Light blue for missing data
    if (capacityFactor === null || capacityFactor === undefined) return '#e6f3ff';
    
    // Round and clamp to valid range
    const rounded = Math.round(Math.max(0, Math.min(100, capacityFactor)));
    return this.hexColors[rounded];
  }

  getIntColor(capacityFactor: number | null): number {
    // Light blue for missing data — #e6f3ff (as in getHexColor) in ABGR form
    if (capacityFactor === null || capacityFactor === undefined) return 0xFFFFF3E6;
    
    // Round and clamp to valid range
    const rounded = Math.round(Math.max(0, Math.min(100, capacityFactor)));
    return this.intColors[rounded];
  }
}

// Export singleton instance
export const capacityFactorColorMap = CapacityFactorColorMap.getInstance();

// Export convenience function
export function getProportionColorHex(capacityFactor: number | null): string {
  return capacityFactorColorMap.getHexColor(capacityFactor);
}