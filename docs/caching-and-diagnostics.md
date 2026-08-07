# Caching & tile-render diagnostics

The whole point of this document: **nobody looking at the site should ever wait
on OpenElectricity.** Asking them for a year of coal data takes several seconds.
Everything below exists so that a person never pays that, and so that we can
check, at any moment, whether it is working.

- [What happens when you load a year](#what-happens-when-you-load-a-year)
- [Why the server lives in Sydney](#why-the-server-lives-in-sydney)
- [Where the data comes from (dev and prod)](#where-the-data-comes-from-dev-and-prod)
- [The layers in detail](#the-layers-in-detail)
  - [Layer 1 — your browser](#layer-1--your-browser)
  - [Layer 2 — the Sydney edge cache](#layer-2--the-sydney-edge-cache)
  - [Layer 3 — the Data Cache](#layer-3--the-data-cache)
  - [Layer 4 — OpenElectricity](#layer-4--openelectricity)
- [Keeping it all warm: the cron warmer](#keeping-it-all-warm-the-cron-warmer)
- [Why we don't just ask OpenElectricity faster](#why-we-dont-just-ask-openelectricity-faster)
- [The client-side cache (TanStack Query)](#the-client-side-cache-tanstack-query)
- [The stats layer](#the-stats-layer)
- [How old is the data?](#how-old-is-the-data)
- [Purging the caches](#purging-the-caches)
- [Tile-render diagnostics](#tile-render-diagnostics)
- [Confirming caching works on prod](#confirming-caching-works-on-prod)
- [Known limitations](#known-limitations)

---

## What happens when you load a year

You ask for 2010. **Four** places might already have the answer, and we try them
in that order. Each one further down costs more.

| # | Where | What it costs | Who fills it |
|---|-------|---------------|--------------|
| 1 | **Your own browser** | nothing — it never leaves your laptop | you, a minute ago |
| 2 | **The Sydney edge cache** — a copy sitting in Vercel's Sydney data centre | one hop to Sydney; our server never even runs | the cron warmer, or the previous visitor |
| 3 | **The Data Cache** — our own server's store, also in Sydney | ~20–130 ms of server work | the cron warmer |
| 4 | **OpenElectricity** — the real source | **~3–9 seconds** | nobody; this is the bill |

Layer 4 is slow because it is genuinely a lot of work: we ask for a whole year
of daily generation for every coal unit, twice (once for the eastern grid, once
for WA), through a queue that paces our requests. **A robot asks for every year
every 10 minutes precisely so that a person never has to.**

Two things follow, and they explain most of this document:

- **Layer 2 is the one that matters to a visitor**, because it answers without
  our server running at all. But an edge cache is per-region: a copy in Sydney
  does nothing for a reader in London, and vice versa.
- **Layer 3 is the one that matters to us**, because it is what stops a layer-2
  miss from becoming a layer-4 bill. It is best-effort storage — Vercel can and
  does evict entries early — so it needs actively keeping alive.

A year is the unit everything is keyed on — one payload per year, at every
layer. Earliest year is 1999, where facility-level NEM data begins.

The **fleet mode** (`full` = every unit that ever operated, `current` =
operating units only) is *not* part of that key. It used to be, and every year
was fetched, cached and warmed twice. It no longer is: the server sends one
roster with a per-unit `status`, and the browser derives the `current` view by
filtering (`src/shared/fleet-filter.ts`). So switching the toggle costs no
request, and there is nothing mode-specific to warm or purge. `/api/stats` is
the exception — its two modes are genuinely different aggregates, not two views
of one result — but both are computed from the same per-year payloads.

---

## Why the server lives in Sydney

`vercel.json` pins the functions with `"regions": ["syd1"]`. Without it Vercel
puts them in `iad1` — Washington DC — and three things go wrong at once for an
Australian audience:

1. Every request that misses the edge crosses the Pacific twice.
2. The Data Cache lives wherever the functions live, so it is in Washington too.
3. **The cron warmer's own request re-enters the CDN wherever it is sent from.**
   Running in Washington, it lovingly refreshed a Washington edge cache that no
   Australian visitor ever touches, while the Sydney edge — the only one that
   gives layer 2's speed — was left to be filled by real visitors and to empty
   out again whenever traffic was thin.

Point 3 is the one that bites. Pinning to `syd1` means the every-10-minute sweep
keeps hot the exact cache our readers hit.

Measured from Sydney with the server still in Washington, an edge hit came back
about three times faster than an origin round-trip, and a cold OpenElectricity
fetch was roughly fifteen times slower again. (Those absolute figures were taken
over a high-latency link, so read the ratios, not the seconds.)

---

## Where the data comes from (dev and prod)

There is **no** dev/mock/staging data provider. In **every** environment the data
is fetched live from the **production OpenElectricity API**
(`https://api.openelectricity.org.au/v4`), authenticated with
`OPENELECTRICITY_API_KEY` from `.env.local`. (The SDK resolves its base URL to
`OPENELECTRICITY_API_URL` if set, else the prod URL — we do not set it.)

`npm run dev` serves both the app and the API route from **one process on one
host/port**: the client fetches `/api/capacity-factors` same-origin, and that
route calls OE prod directly through `CapFacDataService`. So:

- **Dev and prod share the same upstream data.** An anomaly you see in dev will
  also be in prod — confirm with `curl "https://stripes.energy/api/capacity-factors?year=2010"`.
- **The only dev↔prod difference is the cache.** Dev has layers 1, 3 and 4 but no
  layer 2 (there is no CDN in front of `localhost`), and its Data Cache is on
  disk in `.next/cache` rather than Vercel's. A fresh dev instance therefore pays
  a cold fetch on the first request for each year, then serves it from
  disk.
- **To force a re-fetch in dev** (e.g. after changing server-side data shaping),
  `rm -rf .next/cache` and restart, or the stale cached body will keep coming
  back. Note the browser also respects the response `Cache-Control: max-age=…`,
  so an already-open tab can serve a stale body even after a hard reload — use a
  fresh browser context to see server-side data changes.

To inspect OE directly (bypassing our app entirely), a small script using
`OpenElectricityClient` with the `.env.local` key can call `getFacilities` /
`getFacilityData` — useful for telling "OE has no data" apart from "our fetch
dropped it".

---

## The layers in detail

### Layer 1 — your browser

`Cache-Control: public, max-age=60`, set by the data routes.

Deliberately short. The browser cache is **the one layer no purge can reach**, so
a data fix must never be masked by a copy sitting on someone's laptop. Sixty
seconds costs at most one edge round-trip per year per page load, and TanStack
Query dedupes within a session anyway (see below).

### Layer 2 — the Sydney edge cache

`Vercel-CDN-Cache-Control: s-maxage=… , stale-while-revalidate=…`, set per
freshness tier. This header is stripped before it reaches the browser, which is
why the edge and browser lifetimes can differ so wildly.

NEM data is revisable — January can revise the December just past — so **no year
is treated as immutable**. Each year sits in one of three tiers, defined once in
`src/shared/config.ts` (`yearCachePolicy`) and shared by the server route and the
client:

| Tier | Years (today) | Edge lifetime | Serve-stale window |
|------|---------------|---------------|--------------------|
| `current` | the current year | 1 hour | 1 day |
| `recent` | the last 5 past years | 1 day | 7 days |
| `archive` | everything older | 7 days | 30 days |

`stale-while-revalidate` means an edge entry past its lifetime is still served
**instantly** while it refreshes behind the scenes. So as long as an entry
*exists*, nobody waits — which is why keeping entries in existence is the whole
game.

The edge is purgeable: both data routes emit a `Vercel-Cache-Tag` header
(`capacity-factors,cf-<tier>,cf-year-<year>` and `coal-stats,stats-<mode>`)
that the purge endpoint invalidates by tag. Only the stats tag still carries a
fleet mode; capacity factors are one entry per year.

Every internal caller builds its URL with `capacityFactorsPath`
(`src/shared/capacity-factors-url.ts`), including the `&v=<build id>` the
browser sends. The CDN keys on the whole query string, so a caller that omits it
is warming, probing or reading a *different* edge entry from the one visitors
use — which is exactly what the warmer and the diagnostics probe used to do.

### Layer 3 — the Data Cache

`src/server/cf-cache.ts` owns this: one `unstable_cache` wrapper per
freshness tier, with the tier's lifetime as its `revalidate`.

It lives in its own module rather than inside the route for a specific reason.
`unstable_cache` derives its key from the wrapper's key parts plus the call
arguments, so two separately constructed wrappers write two separate entries.
The HTTP route and the cron warmer must therefore share one set of module-level
singletons, or the warmer would be filling a cache nobody reads.

`CF_CACHE_VERSION` in that file is a manual kill switch: bumping it changes every
key at once, so a deploy can discard every tile built by older, buggier code
rather than serving it stale.

A year crossing a tier boundary (current→recent at New Year, recent→archive at
N-6) moves to a different wrapper and hence a different key, costing one cache
miss that the next warmer run absorbs.

### Layer 4 — OpenElectricity

`src/server/cap-fac-data-service.ts` fans out one request per network (NEM, WEM)
per year, through `OEClientQueued` — a queue (`p-queue`) plus retries
(`p-retry`). Two guards keep a fan-out from becoming a stampede:

- **Single-flight.** `unstable_cache` does *not* collapse concurrent misses, so
  without help a visitor and the cron sweep landing on the same cold year would
  each fire an identical pair of upstream requests. `cf-cache.ts` keeps a promise
  per year for the life of the fetch, so the second caller joins the
  first. It lives there, next to the cold-fetch counter, so the two agree: a
  caller that *joins* a fetch paid nothing and is not counted as cold — otherwise
  the `rebuilt` figure below would count wrappers rather than upstream fetches.
- **Priority.** The warmer runs its requests at background priority
  (`withQueuePriority`), so a visitor who lands on a cold year mid-sweep jumps
  ahead of the sweep's remaining work instead of queueing behind it.

---

## Keeping it all warm: the cron warmer

The Data Cache is per-deployment and best-effort: a deploy wipes it, and Vercel
evicts entries under memory pressure — **well inside their nominal lifetime**, as
the built-at timestamps on `/diagnostics` show. Rather than let an unlucky
visitor pay the cold fetch, Vercel Cron re-warms everything on a frequent
schedule via `src/server/cache-warmer.ts`:

| Cron | Schedule | Warms |
|------|----------|-------|
| `warm-all` | every 10 min | every year back to 1999 (one payload each) |
| `warm-stats` | daily, 15:30 UTC (01:30 AEST) | `/api/stats` for both fleet modes (see below) |

`warm-all` sweeps the whole span every 10 minutes so **no year stays cold longer
than the cron interval**, whether it went cold from eviction or a fresh deploy.
In steady state that is cheap: an already-warm year is a Data-Cache read plus one
edge round-trip, no OpenElectricity call.

**Each year is warmed twice, by different means, because the two cache layers
respond to different things:**

1. **In-process** — the warmer calls `getCachedCapacityFactors` directly, with no
   HTTP involved. This is the only way to *guarantee* the Data Cache is touched.
2. **Then, for some years, one plain HTTP self-fetch** of the public URL, which
   re-enters the CDN and keeps the Sydney edge entry from ageing out.

   Not every year, every sweep: a payload is ~230 KB, so refreshing all ~28
   year entries every 10 minutes would move ~6.5 MB a sweep — roughly
   28 GB a month — to keep alive entries that already have a 7-day edge
   lifetime. With the origin in Sydney an edge miss now costs a visitor one
   local round-trip, not a cold fetch, so that is a poor trade for the archive.
   The sweep therefore refreshes the edge for `current` and `recent` years —
   where visitors actually land, and whose edge lifetimes lapse between sweeps
   anyway — plus any year it just rebuilt, whose edge copy is stale by
   definition. Archive years rely on the Data Cache, which the sweep guarantees
   is warm, plus real traffic.

Step 1 exists because of a trap worth remembering: **warming by self-fetching the
public URL does not reliably warm the Data Cache.** If the edge already holds a
copy, the CDN answers, the function never runs, and the Data Cache entry is left
unread — which also makes it first in line for eviction. `cache: 'no-store'` does
not save you; it disables *Next's* fetch cache, not *Vercel's* CDN. This is
exactly the failure this app had: every sweep was absorbed by the edge, so the
layer the sweep existed to protect was quietly starving.

Sweeps fan out `WARM_CONCURRENCY` (4) years at a time — see the next section for
why 4 — and each run logs a line like:

```
warm-all: 28 entries, 3 rebuilt (2007, 2013, 2019), 4210 ms
```

`rebuilt` is the number that matters. It is the **only** visibility we have into
how often the Data Cache really evicts entries. Steady state should be 0; a
persistent trickle means eviction is outpacing the sweep, and the answer would be
a durable store (Vercel Blob or KV) behind layer 3 rather than a faster sweep.

A **fully cold** sweep — every year, all from OpenElectricity — is the slow
case, measured at ~220 s locally over a mobile link back when the sweep covered
twice as many entries (two rosters per year); it has roughly twice that headroom
now. That is close
enough to the 300 s `maxDuration` to matter, so the sweep carries a 240 s
deadline: past that it stops starting new years and reports them as `skipped`
rather than being killed mid-flight. It self-heals, because the years it did warm
are cheap on the next run, so each sweep reaches further than the last. A warm
sweep is far quicker (~37 s locally, and most of that is the edge-refresh
round-trips, which on prod are edge hits rather than full origin responses).

The cron route is gated by `CRON_SECRET` (`isAuthorisedCronRequest`), which Vercel
Cron attaches automatically — **if `CRON_SECRET` is unset in the Vercel project,
every cron fails closed (401) and nothing is warmed.**

---

## Why we don't just ask OpenElectricity faster

Short version: they aren't the ones holding us back, but they can only do about
one heavy request per second, so piling on more parallel requests just makes
everyone queue.

Measured against the live API — bursts of full-year NEM queries, ~644 KB of JSON
each:

| Requests at once | Wall time | Median latency | Errors | Throughput |
|---|---|---|---|---|
| 4, cold at their end | 5.0 s | 4.7 s | **0** | 0.80/s |
| 8, cold at their end | 8.6 s | 8.0 s | **0** | 0.93/s |
| 12, cold at their end | 11.5 s | 10.4 s | **0** | 1.04/s |
| 12, warm in their own 15-min cache | 2.4–2.9 s | 1.8–2.6 s | **0** | 4.1–5.1/s |

Read the last two columns together. **Nothing rate-limits us** — not one 429 at
any level. But going from 4 parallel requests to 12 more than doubled how long
each one took and bought almost no extra throughput: their server is simply doing
the work one at a time. Asking for four years at once is roughly four times
quicker than one at a time; asking for twelve at once is not, it just means
whoever is behind you in the queue waits longer.

So the client-side limits in `src/server/queued-oeclient.ts` (10 in flight, one
start per 100 ms) are a **ceiling, not a target**, and the lever that actually
matters is how many years a caller asks for at once. Four years — eight requests,
since each year is NEM + WEM — is where the curve flattens. That is
`WARM_CONCURRENCY`, and the stats computation uses a similar bound.

(Caveat on the table: measured over a high-latency link, so the ratios between
rows are the signal, not the absolute seconds.)

---

## The client-side cache (TanStack Query)

`src/client/year-queries.ts` (`yearQueryOptions`) caches each year in TanStack
Query, keyed `['capFacYear', year]`. The cached value is **not** raw JSON — it is
the fully pre-rendered `CapFacYear`, including the offscreen canvas tiles
(`createCapFacYear` → one `FacilityYearTile` per facility). `staleTime` matches
the server tier, and adjacent years are prefetched in the background
(`usePrefetchAdjacentYears`). The browser only ever talks to our own route, never
to OpenElectricity.

---

## The stats layer

`/stats` (the coal-generation records page) sits **on top of** everything above.
`computeCoalStats` (`src/server/coal-stats-service.ts`) self-fetches
`/api/capacity-factors` once per year, 1999→current (bounded concurrency via the
shared `mapPool`), and reconstructs MWh from capacity factor × capacity × 24. The
whole result is then cached for a day by `/api/stats` (`unstable_cache`, tagged
`coal-stats`), and `warm-stats` triggers the daily recompute so it never lands on
a user.

Two consequences worth remembering:

- A stats result is **only as fresh as the year payloads it read**, which have
  their own independent tier lifetimes (an archive year can be a week old). This
  is why the page states its own provenance — see below.
- After a purge, the years are all cold, so a `/stats` request recomputes from
  ~28 cold upstream fetches and is slow. Let `warm-all` refill first.

---

## How old is the data?

A stale cache and a genuine upstream data gap look identical on the page unless
the page says which it is. Two mechanisms make the age explicit:

**`created_at` in every capacity-factor payload** is stamped when that payload
was assembled from OpenElectricity — not when it was read from a cache. It is
therefore honest however many cache layers replayed it. The route echoes it as
the **`x-cf-built-at`** response header, so the age can be read without parsing
the body:

```bash
curl -sI "https://stripes.energy/api/capacity-factors?year=2011" \
  | grep -i 'x-cf-built-at\|x-cf-cold\|x-vercel-cache'
```

**The `sources` block in the stats DTO** pairs each year with its `builtAt` and
records the oldest/newest across the set (`StatsSources` in
`src/shared/types.ts`). `/stats` renders it as a line under the intro —
"Records computed 4 hours ago (…) from 28 yearly data files fetched from
OpenElectricity between … and … — oldest 6 days ago" — and `/diagnostics` shows
**Built at** and **Data age** columns per year.

`sources` is optional on the DTO so a payload cached before the field existed
still renders; a year that failed to load is recorded as `builtAt: null` and
counted in the line rather than silently dropped.

---

## Purging the caches

`POST /api/admin/purge`, or the **Purge server caches** button on `/diagnostics`.
Authorised with `CACHE_SECRET`, because a purge forces cold, rate-limited
upstream fetches. That is a **different** secret from the `CRON_SECRET` the
`/api/cron/warm-*` routes use: the cron token is machine-only and never leaves
Vercel, while this one is typed by hand into the `/diagnostics` field, so keeping
them apart means the convenient one can't impersonate cron and either can be
rotated alone. Both fail closed — an unset secret authorises nobody.

| Layer | Cleared by |
|-------|-----------|
| Data Cache (layer 3) | `revalidateTag('capacity-factors' / 'coal-stats')` |
| Vercel CDN edge (layer 2) | `invalidateByTag()` from `@vercel/functions`, against the `Vercel-Cache-Tag` headers |
| Facilities roster memo (24 h) | `clearFacilitiesCache()` — **this instance only** |
| Browser HTTP cache (layer 1) | nothing; hence the 60 s browser `max-age` |

`revalidateTag` alone is not enough: it never touches the edge, because these
routes are `force-dynamic` and set their own `Cache-Control`, so Next never sees
the cached response.

**The purge and the re-warm are two separate requests, deliberately.**
`revalidateTag` invalidates everything carrying that tag *including entries
written later in the same request*, so a re-warm bundled into the purge writes
cache entries that are discarded the moment it returns (verified: a year
re-warmed in-request came back cold on the very next call). The `/diagnostics`
button issues `{mode:'purge'}` then `{mode:'rewarm'}` back to back — still one
click.

```bash
# Purge everything, then re-warm just the years you care about (max 10).
curl -sX POST -H "Authorization: Bearer $CACHE_SECRET" -H 'Content-Type: application/json' \
  -d '{"mode":"purge"}' https://stripes.energy/api/admin/purge | jq '.steps'

curl -sX POST -H "Authorization: Bearer $CACHE_SECRET" -H 'Content-Type: application/json' \
  -d '{"mode":"rewarm","rewarmFrom":2009,"rewarmTo":2013}' \
  https://stripes.energy/api/admin/purge | jq '.steps'
```

Re-warming is capped at 10 years per call: after a purge every year is cold, and
warming all ~28 would blow the 300 s function limit. Years
outside the range refill on the next `warm-all` run (≤ 10 min).

Locally there is no CDN, so the `cdn-edge` step reports *skipped* (gated on
`process.env.VERCEL` — `invalidateByTag` returns success off-platform, which
would otherwise read as a real purge). `rm -rf .next/cache` remains the blunt
local option.

---

## Tile-render diagnostics

Two questions motivated this tooling: *are the caches actually doing their job on
prod?*, and *how long does each tile take to render?*

### `GET /api/diagnostics/tiles`

Probes each year in a range (default 1999→current) and reports **each cache layer
separately**. Implemented as a read-only sibling of the cache warmer
(`probeYears` in `src/server/cache-warmer.ts`).

Parameters: `?years=1999-2026` (max 30), `?year=2024`, or no params for the full
span. It is left **public** — it only re-exercises the already-public
`/api/capacity-factors` route, so it adds no attack surface a caller doesn't
already have, and that lets the `/diagnostics` page read it without a secret.

**Each year is probed twice, in this order:**

1. A **cache-busted** fetch (`&probe=…`, a parameter the route ignores). No edge
   entry exists for that URL, so the request always reaches the function and its
   `x-cf-cold` header describes the **Data Cache** honestly. This runs *first* on
   purpose — a plain fetch that missed the edge would warm the Data Cache and
   hide the very thing we are asking about.
2. A **plain** fetch of the real URL, reporting the **edge** (`x-vercel-cache`,
   `age`) exactly as a visitor would experience it.

The `classification` (`warm` | `cold` | `uncertain`) comes from probe 1 alone.
The earlier single-probe version trusted an edge hit first, which meant a year
could read `warm` while the Data Cache behind it was empty — precisely the state
that produces a surprise cold fetch once the edge entry expires. If you are
reading old screenshots: that is why rows could say `warm` and `was cold` at the
same time.

This honesty has a price: the probe now *pays* the cold fetches it used to hide.
That is intended.

```bash
curl -s "https://stripes.energy/api/diagnostics/tiles?years=2024-2026" | jq '.summary'
```

```jsonc
{
  "yearsProbed": 3,
  "warm": 3, "cold": 0, "uncertain": 0, "failed": 0,
  "edgeHits": 3,           // how many a visitor would get straight from Sydney
  "slowestYear": 2025, "slowestMs": 620,
  "totalMs": 1541,
  "allWarm": true          // the one-line "is the Data Cache healthy?" verdict
}
```

Note the difference between the cache signals and `builtAt`: the first describe
**how this response was served**, the second **how old the data in it is**. A
year can be perfectly warm and still hold week-old data — that combination is the
one that makes an upstream fix look like it never landed.

### The `x-cf-cold` marker

`src/server/cf-cache.ts` records, per instance, every time its wrapped fetch runs
— which only happens on a Data-Cache **miss**, i.e. a genuine cold
OpenElectricity fetch. The route emits two headers on each response:

- `x-cf-cold: true|false` — did **this** request pay a cold fetch?
- `x-cf-cold-ms: <n>` — how long that cold fetch took (when `true`).

Because the marker travels on the same response it is robust to Vercel's
per-instance memory. Do remember it is cached *with* the body, so a copy replayed
from an edge or a browser reports the value from when the entry was built — which
is exactly why the probe bypasses the edge before reading it.

### The `/diagnostics` page

`src/app/diagnostics/page.tsx` is a client page with a purge control and two
tables:

- **Purge server caches** — the one-click purge described above. The secret is
  held in React state only, never `localStorage`, so it lives no longer than the
  tab.
- **Server cache health** — a per-year view of `GET /api/diagnostics/tiles`, with
  separate **Data cache** and **Edge** columns, **Built at** / **Data age**, and a
  "Re-probe" button.
- **Client tile renders** — every tile render in this browser session, with its
  duration and an AEST timestamp.

Client render times live **only** in the browser's heap (there is no server
persistence), so that table populates as you navigate the visualisation and is
only visible in the same tab: `<Link>`-navigate from `/` to `/diagnostics` and the
timings carry over; a hard refresh or a new tab starts empty. The server table
loads regardless.

### Client tile-timing recorder & the Shift+P overlay

`src/client/tile-timing-recorder.ts` is a small in-browser singleton (a bounded
ring buffer with pub/sub) that records three kinds of render:

| Kind | What it measures | Instrumented in |
|------|------------------|-----------------|
| `tile-build` | one facility's canvas for one year | `createCapFacYear` loop |
| `year-build` | all facility tiles for a year | `createCapFacYear` |
| `fetch-build` | end-to-end: network fetch + parse + build | `yearQueryOptions` queryFn |

Network overhead ≈ `fetch-build − year-build`. The same records feed the
**Shift+P** debug overlay's *Timing* tab, while `/diagnostics` is the shareable,
side-by-side view — both read the same singleton.

---

## Confirming caching works on prod

```bash
# Headline verdict — expect "allWarm": true, and edgeHits == yearsProbed.
curl -s https://stripes.energy/api/diagnostics/tiles | jq '.summary'

# What a Sydney visitor actually gets. Expect a HIT, and syd1 in BOTH id fields
# (the first is the PoP that received it, the second the region that ran it).
curl -sI "https://stripes.energy/api/capacity-factors?year=2006" \
  | grep -i 'x-vercel-cache\|x-vercel-id\|age'

# Is the Data Cache holding? Bypass the edge and read the honest marker.
curl -sI "https://stripes.energy/api/capacity-factors?year=2006&probe=1" \
  | grep -i 'x-cf-cold\|x-cf-built-at'
```

A plain `x-vercel-cache: MISS` on a first hit is not automatically a failure — it
means the edge in *your* region was cold, and the origin's Data Cache is right
behind it. But repeated misses on the real URL mean layer 2 isn't being kept
warm, which is the thing the syd1 pinning and the warmer's second step exist to
prevent.

---

## Known limitations

- **The Data Cache is best-effort.** Vercel evicts entries well inside their
  nominal `revalidate` window; we have observed archive years, nominally good for
  seven days, being rebuilt several times a day. The `rebuilt` count in the
  `warm-all` log is how we measure it. If it stays persistently non-zero, the fix
  is a durable store (Vercel Blob or KV) behind layer 3, so a miss costs a ~50 ms
  read instead of an upstream fetch.
- **`maxDuration`**: `vercel.json` applies a 60 s default to all `src/app/api/**`
  functions; the long-running routes (`warm-all`, `/api/diagnostics/tiles`,
  `/api/stats`, `warm-stats`, `purge`) declare 300 s both as route-segment
  exports and as explicit `functions` entries, so the resolved limit does not
  depend on route-segment-vs-glob precedence.
- **Post-deploy cold window**: a deploy wipes the Data Cache, so years stay cold
  until the next `warm-all` run — up to the cron interval (≤ 10 min), plus the
  sweep itself. Closing this fully would need deploy-triggered warming.
- **Start-edge prefetch**: adjacent-year prefetch tries `startYear-2..-1`, which
  at 1999 are out of range and skipped — so a jump straight to the start year is
  always an on-demand fetch with no prefetch overlap.
- **Single-flight has one rough edge**: if a background (warmer) fetch is already
  running and a visitor joins it, the visitor inherits background queue priority.
  Sharing one fetch still beats duplicating it.
- **The browser cache cannot be purged.** A purge clears every server-side layer,
  but a visitor's own HTTP cache is beyond reach. Hence the 60 s browser
  `max-age`.
- **The facilities memo is per-instance.** A purge clears it only on the instance
  that served the purge request; other warm instances keep their roster until the
  24 h TTL expires. Unit metadata (capacities, retirements) can therefore lag a
  purge by up to a day.
- **Purging is not free.** It discards ~28 years, and everything
  outside the re-warm range is cold until `warm-all` catches up. Loading `/stats`
  in that window recomputes from ~28 cold upstream fetches.
