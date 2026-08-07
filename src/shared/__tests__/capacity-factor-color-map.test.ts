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

describe('capacityFactorColorMap', () => {
  describe('red band (below 20%)', () => {
    it('paints 0% red', () => {
      expect(capacityFactorColorMap.getHexColor(0)).toBe('#d24646');
    });

    it('paints 19% red', () => {
      expect(capacityFactorColorMap.getHexColor(19)).toBe('#d24646');
    });

    it('rounds before deciding, so 19.4% is still red', () => {
      expect(capacityFactorColorMap.getHexColor(19.4)).toBe('#d24646');
    });

    it('clamps negatives into the red band', () => {
      expect(capacityFactorColorMap.getHexColor(-10)).toBe('#d24646');
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
    it('paints null pale blue, never red or grey', () => {
      expect(capacityFactorColorMap.getHexColor(null)).toBe('#e6f3ff');
    });

    it('paints null pale blue in the canvas form too', () => {
      expect(capacityFactorColorMap.getIntColor(null) >>> 0).toBe(hexToAbgr('#e6f3ff'));
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
      expect(getProportionColorHex(19)).toBe('#d24646');
      expect(getProportionColorHex(20)).toBe('#bfbfbf');
      expect(getProportionColorHex(null)).toBe('#e6f3ff');
    });
  });
});
