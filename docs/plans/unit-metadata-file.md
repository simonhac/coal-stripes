# Plan — split per-unit metadata out of the year files

> Status: **not started.** Written 18 Aug 2026 on branch `simonhac/port-louis-v1`,
> immediately after the `leadingBackgroundDays` fix in that branch landed.
>
> This lives in `docs/plans/` (committed) rather than a workspace `.context/`
> directory on purpose: it must survive the Conductor worktree that wrote it.

## Goal / definition of done

Every unit's *metadata* (capacity, lifecycle dates, fuel tech, region, …) is
served **once**, inlined into the SSR document, instead of being repeated inside
all 29 per-year capacity-factor files. Done when: the year files carry only the
daily series plus the keys needed to join to a unit; the client reads metadata
from the document with no extra network request; and years 1998–2025 stop
changing content from one day to the next.

## Why (measured this session, against the live API)

Numbers are from the **full-mode current-year payload**, which by design carries
every unit that ever operated (see the roster comment in `src/routes/index.tsx`):

| slice | raw | gzip |
|---|---|---|
| whole per-unit metadata blob, 99 units | 31.3 KB | **2.0 KB** |
| …minus `last_seen` | 28.8 KB | 1.8 KB |
| `last_seen` alone | 2.6 KB | **0.2 KB** |

Two consequences drive the design:

1. **2.0 KB gzipped is small enough to inline.** The SSR document is ~3.5 KB (per
   the comment on `DOCUMENT_CACHE_CONTROL`), so this roughly doubles it — against
   saving a round trip on a zone whose edge is in Singapore. A separate
   `/api/metadata` fetch is *not* worth it at this size.
2. **`last_seen` is the only field that churns daily**, and it is why a year file
   whose generation data froze 25 years ago still rewrites every day — the year
   2000 file was observed carrying `last_seen: 2026-08-18`. Splitting on
   *mutability* (not on "metadata vs series") is what makes 1998–2025 write-once,
   which in turn makes ETags and the cron's rewrite cost behave.

The client barely needs `last_seen` per year anyway: `lifecycleBounds` in
`src/shared/data-gaps.ts` clamps it to `length - 1` for any year before the last,
so for historical years only *whether* it falls past the year end matters.

## Decisions already made

- **Inline into the SSR document; do not add a fetch.** Settled on the size
  measurement above. There is already a precedent for inlining into the head —
  `STALE_DOCUMENT_TRIPWIRE`, wired up in `src/routes/__root.tsx`.
- **Split by mutability, not by category.** Stable fields in the inlined blob;
  drop `last_seen` from the year files entirely (or coarsen it) so historical
  years become immutable.
- **Do not hard-code a per-network start date.** This was considered and
  rejected in favour of shipping the fact as data — see "What this unblocks".

## What this unblocks

`leadingBackgroundDays` in `src/client/cap-fac-year.ts` (landed on this branch)
needs to know the first day a *region* has data. It currently infers that from
whichever one or two year payloads happen to be loaded, via
`regionFirstDataDayIndex`. That is correct for the case it was written for (WEM's
coal series starts 2006-09-20, and every earlier year is wholly empty), but it
cannot distinguish "the record starts here" from "this region happens to have a
year-long collection gap here" — the same limitation `frontierDateFor` in
`src/components/CompositeTile.tsx` guards against on the trailing edge by
refusing to trust any year but `latestDataYear`.

A per-network (or per-region) **first data day** in the metadata blob makes that
boundary a fact rather than an inference. Once it exists, revisit
`leadingBackgroundDays` and the `regionHasDataInWindow` fast path beside it.

## The contract that makes this safe

`lifecycleBounds` is **optional by construction** and `aliveSpan` falls back to
inferring a unit's alive span from the values alone (both in
`src/shared/data-gaps.ts`; the doc comment there explains the "widen only" rule
and why the upstream metadata must never be trusted to *narrow* a span).

So a metadata blob that disagrees with a year file — a deploy skew, a unit
present in one and not the other — degrades to today's inference rather than
breaking. Preserve that. Do not make metadata a hard requirement for rendering a
tile.

## Cache policy it must live within

`src/server/cache-headers.ts`:

- `DOCUMENT_CACHE_CONTROL = 'public, max-age=0, s-maxage=3600'` — the browser
  always revalidates; the edge holds it an hour. So inlined metadata is at worst
  an hour stale, which is fine for a fleet that changes a few times a year.
- `DOCUMENT_TAG` is attached to every SSR document specifically so
  `/api/admin/purge` can reach them, and `src/server/deploy-purge.ts` already
  flushes on deploy. **There is therefore already a mechanism to invalidate the
  inlined metadata** — that is a large part of why inlining is safe here.

The reasoning behind those numbers is written out in the comments above the
constants; read them before changing either. Wider caching background:
`docs/caching-and-diagnostics.md`.

## Pointers

- Branch: `simonhac/port-louis-v1` (target `origin/main`).
- Server builds the DTO, including `commenced` / `commenced_specificity` /
  `last_seen` / `first_seen`: `src/server/cap-fac-data-service.ts` (~L660–710,
  including the aggregate-member branch).
- DTO shape and the caveats on which lifecycle field to trust:
  `src/shared/types.ts` (~L45–90).
- R2 year objects: `src/server/year-store.ts` (`buildYear`, `putYear`,
  `readYear`, and the freshness types).
- Client-side consumers of the metadata: `src/client/facility-year-tile.ts`
  (`spanFor`), `src/shared/data-gaps.ts`, `src/client/cap-fac-year.ts`.
- Document/SSR entry point and the existing inline-script precedent:
  `src/routes/__root.tsx`.
- The 14 metadata fields currently repeated per year: `capacity`, `commenced`,
  `commenced_specificity`, `data_type`, `duid`, `facility_code`,
  `facility_name`, `first_seen`, `fueltech`, `last_seen`, `network`, `region`,
  `status`, `units`.

## Transient state not in the repo

- At the time of writing, branch `simonhac/port-louis-v1` also carried an
  unrelated, uncommitted design-system change and a concurrent edit by another
  agent working on page refreshing. Check `git log` / `git status` before
  assuming this branch is clean.
- `npm run dev` (port 3010) gets a **local, empty R2 bucket**, so the first hit
  on each year computes from OpenElectricity and is slow. `npx wrangler dev
  --remote` binds the real bucket and is much faster for driving the real UI.
- Measuring the browser: the app exposes `data-offset` (where the stripes ARE)
  and `data-target-offset` (where they are HEADED) on `[data-testid=stripes-viz]`.
  **Always assert they are equal before sampling the canvas.** A backgrounded tab
  gets no `requestAnimationFrame`, so the spring never advances and the canvas
  keeps rendering an old window while the header shows the new one — this
  produced a string of false conclusions during the session that wrote this file.

## Next actions

1. Decide the join key and the blob's shape (`duid` is the natural key; confirm
   against the aggregate-member branch in `cap-fac-data-service.ts`, which
   synthesises units).
2. Emit the blob server-side and inline it in the document; read it on the client
   behind a fallback that keeps `aliveSpan`'s value-inferred path working.
3. Remove the now-duplicated fields from the year payloads, and confirm a
   historical year's bytes stop changing between two cron rebuilds.
4. Add the per-network first-data day to the blob and simplify
   `leadingBackgroundDays` / `regionHasDataInWindow` to use it.

## Out of scope / guardrails

- Not a redesign of the stripe rendering. The bug that prompted this is already
  fixed on the branch: WEM rows flipped from page background to a full year of
  pale-blue "no data" the instant one day of real WEM data entered the window
  (measured: 348 of 365 days, on `2005-10-07 → 2006-10-06`). The fix and its
  regression tests are `leadingBackgroundDays` in `src/client/cap-fac-year.ts`
  and the `describe('leadingBackgroundDays')` block in
  `src/client/__tests__/cap-fac-year.test.ts`. Do not revisit it beyond step 4,
  and keep those tests passing.
- Do not commit, or suggest committing, until asked.
- Do not introduce a hard-coded WEM start date as a shortcut — shipping it as
  data is the point of the exercise.
- Australian English, and the null-is-never-zero rule, both still apply (see
  `CLAUDE.md`).
