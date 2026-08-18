/**
 * Maps a daily capacity factor (0–100%, or null for "no data") to the colour
 * of one stripe-day.
 *
 * Encoding: below 20% the unit is effectively offline or barely running, so
 * it reads as a red warning stripe. From 20% up, the value maps linearly onto
 * a grey ramp — 20% is light grey, 100% is black — so a unit running flat out
 * appears as solid dark stripes and partial output as lighter shading. Null
 * (unknown) days are pale blue, deliberately distinct from both.
 *
 * Two of the three anchors are Open Electricity design-system colours; the third
 * deliberately is not.
 *
 *   offline  `red` #C74523     — the brand accent, which the design system also
 *                                uses for its error and alert states.
 *   full     `black` #000000    — the design system also has a `coal_black`
 *                                (#121212) for coal *series*, but that is a
 *                                categorical colour for telling fuels apart in a
 *                                stacked chart, and this ramp has one fuel in it.
 *   no data  #e6f3ff, pale blue — OFF-PALETTE, ON PURPOSE.
 *
 * The exception is worth stating plainly, because "make it a design-system
 * colour" is the obvious change and it is the wrong one. The ramp occupies the
 * entire greyscale axis from #bfbfbf to black, so any grey light enough to sit
 * clear of it — `warm-grey` #F1F0ED is the nearest candidate — is within nine
 * units per channel of the page itself (#FAF9F6). That was tried: gaps went from
 * unmistakable to nearly invisible. Leaving the greyscale axis altogether is
 * what makes "we have no reading for this day" impossible to mistake for a very
 * low one, and this codebase treats that distinction as load-bearing (see the
 * null-is-never-zero rule in CLAUDE.md).
 *
 * Two things tell a reader what the colours mean. `StripesLegend` — the ramp
 * above the stripes — derives its gradient from `getRampGradientCss()` below
 * and its swatch from `NO_DATA_HEX`, so it cannot drift. The welcome dialog's
 * `.welcome-swatch--*` rules in src/styles/opennem.css are hand-written CSS and
 * must be kept in step with these by hand.
 *
 * The ramp is anchored at both ends rather than being a plain `255 × (1 −
 * cf/100)`: its lightest step stays #bfbfbf wherever the red threshold sits, so
 * lowering the threshold widens the ramp instead of washing out its low end.
 *
 * All 101 colours are pre-computed once, in two forms: CSS hex strings for
 * DOM use, and 32-bit ABGR integers for writing directly into a canvas
 * ImageData buffer (little-endian RGBA bytes read as one ABGR uint32).
 */

/** Capacity factors below this (%) read as red — effectively offline. */
export const RED_THRESHOLD_PCT = 20;
/** Grey at the ramp's lightest end (#bfbfbf), i.e. the value at the threshold. */
const RAMP_LIGHTEST_GREY = 191;
/** Pale blue: no reading for this day. Never a capacity factor of zero. */
export const NO_DATA_HEX = '#e6f3ff';

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
    
    if (capacityFactor < RED_THRESHOLD_PCT) {
      // Open Electricity's brand red, #C74523, for anything under the threshold
      r = 199;
      g = 69;
      b = 35;
    } else {
      // Map capacity factor onto the grey ramp
      // 20% -> #bfbfbf (light), 100% -> #000000 (black)
      const clampedCapacity = Math.min(100, Math.max(RED_THRESHOLD_PCT, capacityFactor));

      // Invert so that higher capacity = darker (lower grey value)
      const greyValue = Math.round(
        RAMP_LIGHTEST_GREY * (100 - clampedCapacity) / (100 - RED_THRESHOLD_PCT)
      );
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
    // Pale blue for missing data
    if (capacityFactor === null || capacityFactor === undefined) return NO_DATA_HEX;
    
    // Round and clamp to valid range
    const rounded = Math.round(Math.max(0, Math.min(100, capacityFactor)));
    return this.hexColors[rounded];
  }

  getIntColor(capacityFactor: number | null): number {
    // Pale blue for missing data — #e6f3ff (as in getHexColor) in ABGR form
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

/**
 * The same ramp as a CSS gradient, for the legend above the stripes.
 *
 * A hard step at the threshold — the ramp does not blend out of red — then the
 * grey run. Two stops suffice for that run because CSS interpolates gradients
 * in sRGB by default and `computeColor` is linear in sRGB byte value, so the
 * browser draws the identical curve rather than an approximation of it. Do not
 * add `in oklab` here; it would bend the ramp away from the stripes.
 */
export function getRampGradientCss(): string {
  const offline = capacityFactorColorMap.getHexColor(0);
  const lightest = capacityFactorColorMap.getHexColor(RED_THRESHOLD_PCT);
  const darkest = capacityFactorColorMap.getHexColor(100);
  return (
    `linear-gradient(to right, ` +
    `${offline} 0 ${RED_THRESHOLD_PCT}%, ` +
    `${lightest} ${RED_THRESHOLD_PCT}%, ${darkest} 100%)`
  );
}