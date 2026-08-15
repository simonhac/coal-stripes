# Bug report: null coal unit-days in the OpenElectricity API

Drafted 2026-08-15 for `openelectricity/openelectricity`. Measured against API
version `4.5.11`. Our rendering of the same data: https://stripes.energy/stats

Reproduce the measurement with `npm run test:integration -- gap-adjustments`, or
by hand as described at the end.

---

## Daily energy series use three different representations for "unit not generating" — 10,614 coal unit-days affected

**API:** `GET /v4/data/facilities/{network_code}?metrics=energy&interval=1d`
**Scope:** all 99 coal DUIDs (`fueltech_id=coal_black,coal_brown`,
`status_id=operating,retired`), 1998-12-07 → 2026-08-14.

### Summary

For a unit that is registered but producing nothing, the daily energy series
returns one of three different things, with no way to tell them apart:

1. `0` — unambiguous, correct
2. explicit `null`
3. no row for that day at all

**10,614 unit-days** fall into categories 2 and 3 *strictly between* a unit's
first and last reported reading — while the unit was demonstrably alive. 85 of 99
units are affected.

Because `null` and `0` are semantically distinct (no measurement vs. measured
zero output), a consumer cannot compute a correct capacity factor, availability
figure or fleet total without guessing. We render these as "no data" rather than
report a zero that isn't real.

### The clearest case: MUJA_G1 / MUJA_G2

```bash
curl -sS -G https://api.openelectricity.org.au/v4/data/facilities/WEM \
  -d metrics=energy -d interval=1d \
  -d date_start=2007-01-01 -d date_end=2007-07-01 \
  -d unit_code=MUJA_G1 -H "Authorization: Bearer $KEY"
```

| Window | What the API returns |
|---|---|
| 2007-01-01 → 2007-06-19 | dense daily values, **113 of 170 are explicit `0`** |
| 2007-06-20 → 2012-10-21 | **HTTP 404** `No data available for unit=['MUJA_G1']` — 1,951 days |
| 2012-10-22 → 2018-04-30 | dense daily values, **explicit `0`** almost throughout |

Muja AB units 1 and 2 were mothballed in 2007 and never returned to service — the
same physical state throughout. Yet the series reads as `0` either side of the gap
and as nothing at all in the middle. MUJA_G3/G4 show the identical pattern over
2007-06-20 → 2008-07-24, resuming at `0` on 2008-07-25.

Whatever registration change underlies this is invisible in the API, so it reads
as five and a half years of missing data for a plant whose state was known.

### Recent and ongoing: per-unit dropouts in WEM, 2021–2023

883 unit-days, all explicit `null`, and **not** network-wide outages — other WEM
coal units report normally on the same days:

| Date | Null | Reporting normally |
|---|---|---|
| 2023-05-01 | COLLIE_G1, BW1_BLUEWATERS_G2 | MUJA_G6 3313.98, MUJA_G7 3518.46, MUJA_G8 3569.06, BW2_BLUEWATERS_G1 5065.5 |
| 2022-10-01 | COLLIE_G1, MUJA_G5, MUJA_G8 | MUJA_G6 2339.02, MUJA_G7 1870.73, BW1_BLUEWATERS_G2 2591, BW2_BLUEWATERS_G1 3035.5 |

Longest recent runs: MUJA_G7 2023-05-24→2023-08-09 (78 d), MUJA_G8
2022-09-14→2022-11-28 (76 d), COLLIE_G1 2022-09-14→2022-11-27 (75 d) and
2023-04-01→2023-06-02 (63 d), BW1_BLUEWATERS_G2 2023-04-08→2023-05-16 (39 d).

### Early NEM: December 1998 – 2000

The bulk of the remainder, mostly explicit nulls: LD01 1999-10-29→2000-03-29
(153 d, with ~10,000 MWh/day either side), MM4 426 d, LD03 396 d, MM3 294 d. We
assume much of this is genuinely unrecoverable; the ask here is documentation
rather than backfill.

### Playford B aggregation

`PLAYFB1`–`PLAYFB4` report until late May 1999, then `PLAYB-AG` takes over (last
member interval 1999-05-26 05:45, aggregate's first 10:20). During the overlap the
four members carry **403 interior null unit-days**, with partial metering — some
reporting while siblings are silent on the same day. The transition is
undocumented, so a consumer summing unit DUIDs double-counts, and one reading the
members alone sees a station vanish.

### Acceptance criteria

1. **Dense series.** For any unit and any range inside its actual data extent, the
   response contains exactly one point per interval. A day with no measurement
   appears as an explicit `null`, never an omitted row. No 404 for a sub-range of
   a unit's life.
2. **`0` and `null` documented and enforced as distinct.** `0` = measured, no
   generation; `null` = no measurement available. Published in the docs, never
   interchanged.
3. **A registered, non-generating unit returns `0`** — mothballed, on outage,
   under maintenance — not `null`, and not an absent row.
4. **Where a unit is genuinely off-register, say so** — a queryable registration
   interval (e.g. `registration_periods` on the unit, or a `reason` on the gap),
   so consumers can distinguish "not registered" from "we lost the data".
5. **Regression test — MUJA_G1/G2.** `2007-06-20 → 2012-10-21` returns the same
   representation as `2012-10-22` onwards, or carries an explicit off-register
   marker per (4). Same for MUJA_G3/G4 over `2007-06-20 → 2008-07-24`.
6. **Backfill or explain the recent WEM dropouts** — the 883 unit-days in
   2021–2023 are filled with real values, reported as `0`, or flagged with a
   documented reason. If AEMO-WA data exists for those days, it is ingested.
7. **Known-bad windows published** in machine-readable form, ideally as a per-unit
   coverage figure on the facilities endpoint, so consumers can caveat totals
   rather than silently under-report them.
8. **Playford transition documented**, or exposed as a supersession relationship,
   with the overlap period's partial metering resolved or flagged.
9. **`data_first_seen` is truthful.** It currently reports the start of a unit's
   *later* contiguous run — MM4 claims 2000-02-28 when data exists from
   1999-01-06.
10. **`data_last_seen` is truthful.** The same defect at the other end: LD03
    reports `2022-04-02` while its daily series carries non-null readings through
    `2022-07-19`. A consumer using it to bound a unit's life silently discards 101
    days of real record.

### Reproducing the measurement

For every coal DUID, fetch `metrics=energy&interval=1d` year by year, then count
days that are null or absent strictly between that unit's first and last non-null
reading.

Note `date_end` is **exclusive**: querying `YYYY-12-31` silently drops every
31 December and inflates the count by 27 unit-days per unit.

Result: 10,614 unit-days across 85 of 99 units.
