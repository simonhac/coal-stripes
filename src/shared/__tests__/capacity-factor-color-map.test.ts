import { capacityFactorColorMap, getProportionColorHex } from '../capacity-factor-color-map';

/**
 * #rrggbb -> the ABGR uint32 the canvas renderer expects (alpha 255).
 * Normalised unsigned: the map builds its ints with `<<`, which yields a signed
 * (negative) value, while the null colour is a positive literal. Both land the
 * same bytes in a Uint32Array, so compare them unsigned.
 */
function hexToAbgr(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * The ramp's two named anchors, named so a palette change is a two-line edit
 * here rather than a nine-assertion sweep.
 *
 * `OFFLINE_RED` is Open Electricity's brand red. `NO_DATA` is deliberately NOT a
 * design-system colour: the grey ramp occupies the whole greyscale axis, so
 * "unknown" has to leave that axis to stay unmistakable. See the header comment
 * on capacity-factor-color-map.ts.
 */
const OFFLINE_RED = '#c74523';
const NO_DATA = '#e6f3ff';

describe('capacityFactorColorMap', () => {
  describe('red band (below 20%)', () => {
    it('paints 0% red', () => {
      expect(capacityFactorColorMap.getHexColor(0)).toBe(OFFLINE_RED);
    });

    it('paints 19% red', () => {
      expect(capacityFactorColorMap.getHexColor(19)).toBe(OFFLINE_RED);
    });

    it('rounds before deciding, so 19.4% is still red', () => {
      expect(capacityFactorColorMap.getHexColor(19.4)).toBe(OFFLINE_RED);
    });

    it('clamps negatives into the red band', () => {
      expect(capacityFactorColorMap.getHexColor(-10)).toBe(OFFLINE_RED);
    });
  });

  describe('grey ramp (20% and above)', () => {
    it('starts the ramp at #bfbfbf on the threshold', () => {
      expect(capacityFactorColorMap.getHexColor(20)).toBe('#bfbfbf');
    });

    it('rounds 19.5% up to the first grey step', () => {
      expect(capacityFactorColorMap.getHexColor(19.5)).toBe('#bfbfbf');
    });

    it('ends the ramp at black for a unit running flat out', () => {
      expect(capacityFactorColorMap.getHexColor(100)).toBe('#000000');
    });

    it('clamps above 100% to black', () => {
      expect(capacityFactorColorMap.getHexColor(120)).toBe('#000000');
    });

    it('darkens monotonically across the ramp', () => {
      const greyOf = (cf: number) => parseInt(capacityFactorColorMap.getHexColor(cf).slice(1, 3), 16);
      for (let cf = 20; cf < 100; cf++) {
        expect(greyOf(cf + 1)).toBeLessThanOrEqual(greyOf(cf));
      }
      expect(greyOf(100)).toBeLessThan(greyOf(20));
    });
  });

  describe('no data', () => {
    it('paints null pale blue, never red or a ramp step', () => {
      expect(capacityFactorColorMap.getHexColor(null)).toBe(NO_DATA);
    });

    it('paints null pale blue in the canvas form too', () => {
      expect(capacityFactorColorMap.getIntColor(null) >>> 0).toBe(hexToAbgr(NO_DATA));
    });
  });

  describe('getIntColor', () => {
    it('agrees with getHexColor across the range', () => {
      for (const cf of [0, 19, 20, 50, 99, 100]) {
        expect(capacityFactorColorMap.getIntColor(cf) >>> 0).toBe(
          hexToAbgr(capacityFactorColorMap.getHexColor(cf))
        );
      }
    });
  });

  describe('getProportionColorHex', () => {
    it('delegates to the shared map', () => {
      expect(getProportionColorHex(19)).toBe(OFFLINE_RED);
      expect(getProportionColorHex(20)).toBe('#bfbfbf');
      expect(getProportionColorHex(null)).toBe(NO_DATA);
    });
  });
});
