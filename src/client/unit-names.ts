/**
 * How a unit's DUID is shown to a reader.
 *
 * WEM DUIDs carry their station as a prefix — `MUJA_G5`, `COLLIE_G1` — which is
 * redundant beside the facility name it is always displayed with, so only the
 * suffix is kept. NEM DUIDs (`BW01`, `LD04`) are already short and pass through.
 *
 * Shared so the stripe tooltip and the facility hovercard can't drift apart.
 */
export function formatUnitName(unitName: string, network: string | undefined | null): string {
  if (network?.toUpperCase() === 'WEM' && unitName?.includes('_')) {
    return unitName.split('_').pop() || unitName;
  }
  return unitName;
}
