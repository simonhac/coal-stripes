/**
 * The one definition of what the `current` fleet view means.
 *
 * The server serves a single payload per year — the FULL roster, every unit
 * that ever operated, each tagged with its `status`. The `current` view (only
 * units operating today) is derived from it by filtering, here. Both consumers
 * use this module so the two can never drift:
 *
 *   • the browser, in @/client/year-queries, to build the `current` tiles from
 *     the same payload the `full` tiles were built from; and
 *   • the server, in @/server/coal-stats-service, which still computes genuinely
 *     per-mode aggregates (peak generation across every unit ever ≠ peak across
 *     today's fleet) but now reads one payload per year instead of two.
 *
 * This used to be two OpenElectricity queries and two of every cache entry. It
 * collapsed once GeneratingUnitDTO started carrying `status`; see the
 * equivalence note on isInFleet below for why the collapse is exact.
 */

import type {
  FleetMode,
  GeneratingUnitDTO,
  GeneratingUnitCapFacHistoryDTO,
} from './types';

/**
 * Is this unit part of the given fleet view?
 *
 * `full` keeps everything. `current` reproduces what the server used to do in
 * `current` mode, which was TWO things, not one:
 *
 *   1. it asked OpenElectricity for `status_id: ['operating']`, dropping
 *      retired units; and
 *   2. it dropped units with no data at all for the requested year (`full`
 *      keeps them as an all-null row that renders as "no data" pale blue).
 *
 * Rule 2 is reproduced here as "has at least one non-null day". Note what that
 * is and isn't: the server dropped a unit when OpenElectricity returned it no
 * ROWS, whereas this drops a unit whose rendered year is entirely null. Those
 * coincide unless a unit has rows that all serialise to null — every reading's
 * energy null, or a null/zero registered capacity making the capacity factor
 * incomputable. Such a row is indistinguishable, in the payload and on screen,
 * from a unit with no rows at all: both render as "no data" pale blue, and
 * a zero-capacity unit's row is zero pixels high regardless.
 *
 * Deliberately not carrying an explicit "upstream sent rows" flag to preserve
 * that distinction. It has never arisen — every year from 1999 to 2026 was
 * checked against the old two-roster prod API and no `current` payload has ever
 * contained an all-null row — and it describes how OpenElectricity chose to
 * serialise an absence, not anything true of the power station. (1998 was added
 * to the record later, when OpenElectricity extended its history back to 7 Dec
 * 1998; that check has not been re-run for it.)
 */
export function isInFleet(unit: GeneratingUnitDTO, mode: FleetMode): boolean {
  // A folded member belongs to NO fleet view, `full` included: its readings are
  // already in the absorbing row, so showing it would draw Playford B as five
  // rows and count its generation twice. It rides in the payload purely so the
  // stats fold can see its own nulls — see GeneratingUnitDTO.foldedInto.
  if (unit.foldedInto) return false;
  if (mode === 'full') return true;
  return unit.status === 'operating' && unit.history.data.some((v) => v !== null);
}

/**
 * A year's payload as the given fleet view sees it.
 *
 * A payload that loses nothing is returned unchanged (same object, no copy);
 * otherwise a new envelope wraps a filtered array — the unit objects themselves
 * are shared, not cloned, so holding both views of a year costs one payload plus
 * one array.
 *
 * Note there is no `mode === 'full'` fast path. `full` keeps every unit the
 * visualisation has a row for, which is not the same as every unit in the
 * payload: folded members ride along for the stats fold and must be dropped from
 * both views. Short-circuiting here is what would put them on screen.
 */
export function filterFleet(
  dto: GeneratingUnitCapFacHistoryDTO,
  mode: FleetMode,
): GeneratingUnitCapFacHistoryDTO {
  const data = dto.data.filter((unit) => isInFleet(unit, mode));
  return data.length === dto.data.length ? dto : { ...dto, data };
}
