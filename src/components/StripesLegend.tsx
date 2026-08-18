import React from 'react';
import {
  RED_THRESHOLD_PCT,
  NO_DATA_HEX,
  getRampGradientCss,
} from '@/shared/capacity-factor-color-map';

/**
 * The key to the stripes: the capacity-factor ramp, its axis, and the pale blue
 * that means "no reading". It sits on the date row, left-aligned on the same
 * gutter the stripes below start from.
 *
 * A port of Open Electricity's stripes legend
 * (explore.openelectricity.org.au/stripes/nem), which is a d3 `axisBottom` over
 * a 200×10 ramp: 6px tick rules, 10px centred labels, no domain line. There is
 * no d3 in this project and one gradient does not justify adding it, so the
 * ramp is a CSS gradient and the ticks are absolutely positioned — the same
 * drawing by other means.
 *
 * One deliberate departure: d3 centres every label on its tick, so the end
 * labels hang outside the ramp. Here the first and last are anchored to the
 * ends instead, because the legend's left edge has a job the original's does
 * not — lining up with the region and unit labels below it.
 *
 * The colours are not restated here. They come from the map that colours the
 * stripes themselves, which is the whole point of a legend.
 */

/** Where the axis is marked. The threshold is included because the ramp does
 *  something abrupt there, and a reader deserves to be told where. It is the
 *  one that goes when there is no room — see opennem.css. */
const TICKS_PCT = [0, RED_THRESHOLD_PCT, 50, 100];

export function StripesLegend() {
  return (
    <div
      className="opennem-legend"
      role="img"
      aria-label={
        `Capacity factor: red below ${RED_THRESHOLD_PCT} per cent, then light ` +
        `grey at ${RED_THRESHOLD_PCT} per cent darkening to black at 100 per ` +
        `cent. Pale blue means no data.`
      }
    >
      <div className="opennem-legend-ramp">
        <div
          className="opennem-legend-bar"
          style={{ backgroundImage: getRampGradientCss() }}
        />
        {TICKS_PCT.map((pct) => (
          <span
            key={pct}
            className="opennem-legend-tick"
            data-value={pct}
            /* The anchor carries the rule with it (see opennem.css), which is
               also what keeps the 1px marks at either end inside the bar rather
               than straddling its edge. */
            data-anchor={pct === 0 ? 'start' : pct === 100 ? 'end' : undefined}
            style={{ left: `${pct}%` }}
          >
            {pct}%
          </span>
        ))}
      </div>

      {/* The ramp's shape in miniature: a sample on the bar's line, its label
          on the tick labels'. The swatch takes its width from the words under
          it. */}
      <span className="opennem-legend-nodata">
        <span
          className="opennem-legend-swatch"
          style={{ background: NO_DATA_HEX }}
        />
        <span className="opennem-legend-nodata-label">no data</span>
      </span>
    </div>
  );
}
