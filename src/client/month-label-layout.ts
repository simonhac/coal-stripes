/**
 * How far right a month cell's label must start to clear the leading
 * page-background overlay CapFacXAxis paints over the days before the region's
 * first data day.
 *
 * The overlay sits above the month cells (z-index 11 vs 10) and each label is
 * pinned to the left edge of its own cell, so without this a month the overlay
 * half-covers reads "ec" instead of "Dec". Because the overlay's edge *is* the
 * data-start line, indenting to it leaves the label pinned to that day and
 * travelling with the stripes through a rubber-band overstep.
 *
 * All three arguments are percentages of the strip — the same basis the
 * overlay's `left`/`width` resolve against — so the label lands exactly on the
 * overlay's edge. Returns 0 for cells the overlay does not straddle, including
 * ones it wholly covers: those sit behind an opaque overlay, and any text they
 * spill sideways is painted over by the next cell's opaque background.
 *
 * @param startPercent the cell's left edge
 * @param widthPercent the cell's width
 * @param pastPercent  the overlay covers [0, pastPercent)
 */
export function getMonthLabelIndentPercent(
  startPercent: number,
  widthPercent: number,
  pastPercent: number,
): number {
  const indent = pastPercent - startPercent;
  return indent > 0 && indent < widthPercent ? indent : 0;
}
