import { describe, it, expect } from 'vitest';
import { getMonthLabelIndentPercent } from '@/client/month-label-layout';

// Everything is a percentage of a 365-day strip, so express the fixtures in days
// and convert — that is how CapFacXAxis builds both the cells and the overlay.
const pct = (days: number) => (days / 365) * 100;

describe('getMonthLabelIndentPercent', () => {
  it('is a no-op when there is no leading overlay', () => {
    // The resting leftmost window: 7 Dec 1998 – 6 Dec 1999, pastPct === 0.
    expect(getMonthLabelIndentPercent(0, pct(25), 0)).toBe(0);          // Dec 1998
    expect(getMonthLabelIndentPercent(pct(25), pct(31), 0)).toBe(0);    // Jan 1999
    expect(getMonthLabelIndentPercent(pct(359), pct(6), 0)).toBe(0);    // Dec 1999
  });

  it('indents the month the overlay straddles by the masked part of that cell', () => {
    // Rubber-banded to a window starting 20 Nov 1998, data starting 7 Dec 1998:
    // the overlay covers the first 17 days, six of which are December's.
    const pastPct = pct(17);
    expect(getMonthLabelIndentPercent(pct(11), pct(31), pastPct)).toBeCloseTo(pct(6), 10);
  });

  it('leaves cells the overlay wholly covers alone', () => {
    // The 11-day November sliver in the same window: behind an opaque overlay,
    // so indenting it would only move text nobody can see.
    expect(getMonthLabelIndentPercent(0, pct(11), pct(17))).toBe(0);
  });

  it('leaves cells after the overlay alone', () => {
    expect(getMonthLabelIndentPercent(pct(42), pct(31), pct(17))).toBe(0);
  });

  it('is a no-op when the overlay ends exactly on a cell boundary', () => {
    expect(getMonthLabelIndentPercent(pct(11), pct(31), pct(11))).toBe(0);  // at its left edge
    expect(getMonthLabelIndentPercent(pct(11), pct(31), pct(42))).toBe(0);  // at its right edge
  });
});
