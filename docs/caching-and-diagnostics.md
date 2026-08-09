# Caching & tile-render diagnostics

The whole point of this document: **nobody looking at the site should ever wait
on OpenElectricity.** Asking them for a year of coal data takes several seconds.
Everything below exists so that a person never pays that, and so that we can
check, at any moment, whether it is working.

- [What happens when you load a year](#what-happens-when-you-load-a-year)
- [Where the data comes from (dev and prod)](#where-the-data-comes-from-dev-and-prod)
- [The layers](#the-layers)
- [Freshness tiers](#freshness-tiers)
- [The R2 store and its refresher](#the-r2-store-and-its-refresher)
- [Why this is a store and not a warmer](#why-this-is-a-store-and-not-a-warmer)
- [Why we don't just ask OpenElectricity faster](#why-we-dont-just-ask-openelectricity-faster)
- [The client-side cache (TanStack Query)](#the-client-side-cache-tanstack-query)
- [The stats layer](#the-stats-layer)
- [How old is the data?](#how-old-is-the-data)
- [Purging the cache](#purging-the-cache)
- [Diagnostics](#diagnostics)
- [Confirming caching works on prod](#confirming-caching-works-on-prod)
- [Runtime traps worth knowing](#runtime-traps-worth-knowing)
- [Analytics](#analytics)
- [Static assets](#static-assets)

---

## What happens when you load a year

The browser asks our own Worker for `/api/capacity-factors?year=2024`. It never
talks to OpenElectricity — the API key lives only on the server.

1. **Cloudflare Workers Cache** answers if it holds that year. The Worker does
   not run at all. This is the fast path.
2. On a miss, the Worker runs and reads the year from **R2**, streaming the
   stored bytes straight back (~10 ms; the JSON is never parsed). Concurrent
   misses for the same year are **collapsed**: Cloudflare runs the Worker once
   and streams the one response to everybody waiting.
3. Only if R2 has no object for that year does anything reach OpenElectricity —
   a new year, or a fresh bucket. The payload is written to R2 on the way out, so
   it happens once, ever.
4. The client caches the result again — as pre-rendered canvas tiles, not JSON.

`x-cf-source` on the response says whether step 2 or step 3 answered: `r2` or
`upstream`. In steady state it is always `r2`.

---

## Where the data comes from (dev and prod)

There is **no** dev/mock/staging data source. In every environment the data comes
from the **production OpenElectricity API**
(`https://api.openelectricity.org.au/v4`, keyed by `OPENELECTRICITY_API_KEY`).

`npm run dev` runs the whole app — routes included — in **workerd**, via the
Cloudflare Vite plugin, on the same host and port as the client. The one thing
dev does not have is Workers Cache: it exists only on deployed Workers. It *does*
have R2, simulated by miniflare, so dev exercises the same read path as
production — R2 first, upstream and backfill on a miss.

That makes the local store the dev equivalent of the old `.next/cache`: the first
request for a year is slow, everything after it is instant. **`rm -rf
.wrangler/state` to force a re-fetch** — e.g. after a server-side data change.
(The root `CLAUDE.md` still says `rm -rf .next/cache`; that is left over from
Next and no longer applies.)

Because dev and prod share the same upstream, a data anomaly seen in dev will
match prod — compare with
`curl https://stripes.energy/api/capacity-factors?year=2024`.

---

## The layers

Three, where there used to be four.

| Layer | Lifetime | Purgeable? | Cost of a miss |
|---|---|---|---|
| Browser HTTP cache | `max-age=60` | **No** — which is why it is kept short | one edge round-trip |
| Cloudflare Workers Cache | `s-maxage` per freshness tier | Yes, by tag | an R2 read, ~10 ms |
| **R2** (`DATA` binding) | **never expires** | Not by purge — see below | an OpenElectricity fetch |
| *(OpenElectricity)* | 3–9 s, and no reader should ever reach it | n/a | — |

The important line is the third. R2 is the **floor**: because objects do not
expire, the layer above it can be cold, purged or brand new and the worst a
visitor pays is an R2 read. Everything above R2 is an accelerator, not a
guarantee. This is the inversion that made the design work — the problem was
never that the cache went cold, it was that a *miss* cost 12.8 s.

R2 is deliberately **not** cleared by `/api/admin/purge`: the objects are the
durable copy, and dropping them would put the next visitor back on the slow path.
To force a genuine rebuild, bump `CF_DTO_VERSION` (which renames the whole key
namespace) or delete objects with `wrangler r2 object delete`.

Workers Cache is **tiered internally** — a lower tier near the reader, an upper
tier that aggregates fills network-wide — but it is one cache with one
invalidation mechanism, configured entirely by the headers each route sets in
`src/server/cache-headers.ts`:

```
Cache-Control: public, max-age=60, s-maxage=<tier>, stale-while-revalidate=<swr>
Cache-Tag:     capacity-factors,cf-<tier>,cf-year-<year>,cf-dto-<CF_DTO_VERSION>
```

`max-age` governs the browser, `s-maxage` the shared cache. The key includes the
path **and the full query string** (in order), so `?year=2024` and `?year=2025`
are naturally separate entries — **and the Worker version**, so a deploy starts
cold.

**There is no URL cache-buster.** Under the old Vercel setup the URL carried
`&v=BUILD_ID` so a deploy would rotate it; that was needed because three layers
could disagree about which deploy's payload shape they held. Here the version is
already in the cache key, and shape changes are invalidated by bumping
`CF_DTO_VERSION` (`src/shared/config.ts`) and purging that tag.

### Why the version is in the key

`cross_version_cache` was **on** until 2026-08-09, so entries survived deploys —
argued for on the grounds that the app deploys often for client changes while the
year JSON almost never changes shape. That reasoning holds for the data and is
wrong for exactly one response: the **SSR document**, which embeds Vite's
content-hashed asset URLs and is therefore version-specific by construction.

What that cost, measured the day automatic deployment shipped: the document
cached at 09:38 UTC survived the 11:22 UTC deploy and was still being served at
11:34, naming five JS chunks and a stylesheet that no longer existed. Every one
404'd and the site rendered its loading spinner and nothing else. The same
request with a cache-busting query string returned the correct document with all
assets 200 — which is the fastest way to tell this failure apart from a bad
build. `/stats` and `/diagnostics`, cached earlier, had already aged out and were
fine, so the blast radius is "whatever was cached shortly before a deploy", for
up to the entry's remaining life.

Turning it off costs one R2 read per year on the first request after a deploy.
That is the floor doing its job — see the table above — and it is the cheaper
half of the trade.

The document now also states its own policy rather than relying on the runtime
caching it anyway (`applyDocumentCacheHeaders` in `src/server/cache-headers.ts`,
applied in `src/worker.ts`):

```
Cache-Control: public, max-age=0, s-maxage=3600
Cache-Tag:     html
```

The tag is an escape hatch — `/api/admin/purge` can clear documents by hand — not
the mechanism. Version keying is what makes a deploy correct.

---

## Freshness tiers

`YEAR_CACHE_TIERS` in `src/shared/config.ts`. NEM data is revisable — January can
revise the December just past — so no year is treated as immutable.

| Tier | Years | `s-maxage`, and how often R2 is rewritten |
|---|---|---|
| `current` | this year | 1 hour |
| `recent` | the last 5 | 1 day |
| `archive` | everything older | 1 week |

The tiers do **two** jobs from one definition: they set `s-maxage` on the
response, and they are read by the refresher as a write schedule. Same question
either way — how long before this year's numbers might have moved — so keeping
them in one place is what stops the cache and the store from disagreeing about
what "fresh" means.

Future years are `Cache-Control: no-store` — the data does not exist yet — and
are never written to R2, for the same reason.

### Where in the window each year falls

The *window* comes from the table above. The *phase* — which instant inside the
window a given year is rebuilt at — is `src/server/refresh-schedule.ts`, and is
server-only: the client has no use for it.

Dueness compares **absolute slot boundaries**, not elapsed time since the last
write. That distinction is the whole point. Age-based dueness makes the schedule
a function of when the last build happened, so a cold bucket stamps all 28 years
at one instant and they stay locked together for good — on 2026-08-08, 2006,
2019, 2021 and 2025 were all built within 26 seconds of each other, and the
archive tier rebuilt all 22 years in a single tick every week.

Each tier's window is cut into as many slots as the tier has years, and a year
takes slot `year % slots`. Because tiers are runs of *consecutive* years that is
a bijection, so they spread perfectly evenly with no hashing:

| Tier | Slots | Effect |
|---|---|---|
| `current` | 1 | on the hour |
| `recent` | 5 | one of the five years every 4.8 hours |
| `archive` | 7 | three or four of the twenty-two years each day |

Aggregate work is unchanged — ~32 year-builds a day either way — but it is
spread over the 144 daily ticks instead of arriving in a weekly burst.

`current` gets one slot deliberately, so its phase is zero and it rebuilds on
the hour. Brisbane is UTC+10 with no DST, so **every Brisbane midnight is an
hour boundary** and the first tick after midnight rebuilds. That matters because
the DTO nulls today and the future, so the current year's payload gains its new
day at midnight and at no other time. Before this, a payload built at 23:30 held
until 00:30 — measured at 00:04 on 2026-08-09, the live site's freshest 2026
payload still ended at 7 August.

---

## The R2 store and its refresher

Every year's payload, and the stats payload, live in the `coal-stripes-data`
bucket (binding `DATA`, located in Oceania alongside the readers):

```
v1/years/2024.json      # v1 = CF_DTO_VERSION
v1/stats.json
```

The key is namespaced by DTO version, so bumping `CF_DTO_VERSION` gives the new
shape a fresh namespace: old objects become *unreachable* rather than wrong.

Objects store the **serialised response bytes**, with three fields in
`customMetadata`. That is what lets the read path do `new Response(object.body)`
— 180 KB of JSON is streamed without ever being parsed, and the headers are read
from metadata rather than from the body.

| Field | Meaning |
|---|---|
| `builtAt` | when we last fetched this year from OpenElectricity |
| `contentHash` | SHA-256 of the payload with `created_at` blanked |
| `dataChangedAt` | when the numbers last actually *moved* |

The hash is what separates a revision from a re-fetch. Every rebuild produces a
new `created_at`, so the bytes always differ; without the hash the store cannot
tell whether anything happened, and every rebuild has to be treated as if it
did. `dataChangedAt` is also the measurement that would justify lengthening the
archive window: if it stays weeks behind `builtAt` for the 2000s, the weekly
rebuild is buying nothing. Both are visible from outside as `x-cf-built-at` and
`x-cf-data-changed-at`.

`wrangler.jsonc` runs `*/10 * * * *` into the `scheduled` handler in
`src/worker.ts`, which calls `refreshAll()` (`src/server/store-refresher.ts`).
Each tick:

1. `HEAD` each of the 28 years, compare `builtAt` against the year's slot, and
   rebuild only what is due. Most ticks write nothing. A year already past twice
   its window logs `refresh:stale` — a healthy sweep rebuilds within one cron
   interval of a boundary, so that means earlier ticks have been failing.
2. If any year's numbers **changed** — or the stored stats payload is missing or
   a day old — refold `/api/stats` and store it. Order matters: stats fold the
   year payloads, so doing it first would fold the previous generation.

   The age condition is a backstop, not decoration. Without it, a tick that
   rewrites years and *then* fails the fold would leave every later tick seeing
   an unchanged set of years, so the stats object would stay missing until some
   visitor paid ~40 s to rebuild it.

   The trigger is *changed*, not *written*. Before the payload hash existed, the
   current year's hourly rewrite counted even when it re-fetched identical
   numbers, so the fold ran ~24 times a day to produce the same answer.
3. **Purge the Workers Cache tags for whatever changed** — `cf-year-<y>` per
   year, plus `coal-stats`. Last, once both are stored: purging first would send
   the next reader to R2 for the copy we were about to replace.

   Without this the R2 write is invisible. Workers Cache holds its copy for the
   full `s-maxage`, which is the same window the refresher runs on, so a reader
   could see a payload up to *two* windows old. Measured on 2026-08-09: R2's
   `stats.json` was built `23:30:13`, while the response being served had
   `created_at 15:20:39` and was pinned there for another 16 hours.

   Purging from `scheduled` is not the same thing as *caching* from `scheduled`,
   which is impossible (see below) — a purge is a control-plane call that
   neither reads nor writes the cache. Cloudflare caps a purge at 100 operations
   per request on every plan, and this zone (Free) at 5 purge requests a minute;
   one batched call a tick is nowhere near either.

Watch the `refresh` log line:
`{written, changed, skipped, deferred, failed, stale, statsWritten, statsChanged, purgedTags, totalMs}`.
`written` counts rebuilds, `changed` counts the subset whose numbers moved, and
`deferred` counts years the 4-minute budget ran out before reaching — worth
telling apart from `skipped`, which just means not due.

Expect `changed` to equal `written` for the first week after this shipped, then
drop: objects stored before the hash existed have no `contentHash` to compare
against, so each year's first rebuild under the new code reports a change once.
An archive year does not reach that point until its next weekly slot.

**Cost.** 28 HEADs every ten minutes is ~121k class-B ops a month against a 10M
free allowance; the writes are ~1k class-A a month against 1M. 28 years × ~200 KB
is ~5.6 MB against 10 GB. The storage is comfortably free. What is *not* free is
the CPU to build a payload — see below.

### Where the Worker actually runs

Two separate things. Only one of them is ours to control, and conflating them
wastes a lot of time — so, precisely:

**1. Where the Worker executes. Ours, and set to Sydney.**

```jsonc
"placement": { "mode": "targeted", "region": "aws:ap-southeast-2" }
```

`targeted` is static placement: no dynamic analysis, no warm-up, no dependence
on multi-region traffic. (`mode: "smart"` is the dynamic alternative and a poor
fit here — one subrequest, Australian-only traffic — and measures identically.)

The config is a discriminated union and its validation errors are misleading if
you mix the halves:

| mode | key | values |
|---|---|---|
| `smart` | `hint` | Cloudflare regions: `wnam enam sam weur eeur apac oc afr me` |
| `targeted` | `region` | cloud regions: `provider:region`, e.g. `aws:ap-southeast-2` |

Ask for `hint` with `targeted` and it reports that mode must be `off|smart`;
ask for `region` with `smart` and it reports `off|targeted`. `oc` placed us in
Melbourne; `aws:ap-southeast-2` is Sydney exactly. Confirm with the
`cf-placement` response header — `remote-SYD`.

The bucket is in the same region (`--location oc`, confirmed `location: OC` via
`wrangler r2 bucket info`), so the Worker's R2 read is local.

**2. Which colo terminates the request. Not ours, and it is Singapore.**

Measured from a Telstra connection (AS1221) in Melbourne, no WARP, Saturday
midday — so not peak-hour congestion:

```
cloudflare.com                      ->  cf-ray: ...-MEL
coal-stripes.simon-8e9.workers.dev  ->  cf-ray: ...-SIN
```

Three consecutive samples each, same moment. Ruled out: our network (same
connection reaches MEL for `cloudflare.com`); a `workers.dev` artefact (a real
Workers Custom Domain on our own zone gave the same SIN); time of day; and
placement (SIN predates any placement config and persists under all of them).

**The measurement that settles which layer is at fault:** a cache HIT never
invokes the Worker at all — and it is still ~0.30 s, against ~0.08 s from
Vercel's `syd1`. No placement setting can touch that, because there is no
execution to place. The gap is the network path to the entry colo.

Medians of 12 interleaved samples, cache warm both sides:

| | Vercel `syd1` | Cloudflare | ratio |
|---|---|---|---|
| TCP connect (1 RTT) | 0.011 s | 0.095 s | 8.6x |
| TLS complete | 0.048 s | 0.200 s | 4.2x |
| TTFB, HTML | 0.080 s | 0.309 s | 3.9x |
| TTFB, API | 0.081 s | 0.306 s | 3.8x |

**The whole gap is one round trip.** Connect is a single RTT — 11 ms to Sydney,
95 ms to Singapore — and the TLS handshake multiplies that by ~3. Nothing on
Cloudflare's side is slow; it is simply 6,000 km further away.

Which means the cold-request ratio badly overstates real-world impact, because a
browser pays the handshake **once** and then multiplexes everything over that
connection. Measured on a warm connection:

| | Vercel `syd1` | Cloudflare |
|---|---|---|
| TTFB, 2nd+ request (connection reused) | 0.031–0.101 s | ~0.100 s |
| 7 year payloads, parallel over HTTP/2 | ~0.75 s | ~1.08 s |

So the honest figure for a real visitor is **+0.2 s once on connection setup,
then ~1.4x on a full data load** — not the ~4x a single cold `curl` suggests.

Cloudflare appears to control which IP ranges are advertised from which colos,
tiered by plan — our zone sits on the shared `104.21.x`/`172.67.x` ranges while
`cloudflare.com` is on `104.16.x`. Cloudflare's pricing page lists "Network
Prioritization" as **Enterprise-only**, which means the widely-repeated advice
that the Business plan ($200/mo) fixes Australian routing is anecdote that
contradicts the official feature table. There is no plan worth buying to fix
this.

**Confirmed after cutover, and the prefix is provably the whole cause.** Force
the *same hostname and SNI* onto Cloudflare's other range and the colo changes
with it:

```
curl --resolve stripes.energy:443:104.16.132.229 https://stripes.energy/  ->  ...-MEL, ttfb 0.044 s
curl                                             https://stripes.energy/  ->  ...-SIN, ttfb 0.341 s
```

Identical zone, identical handshake, identical Worker; the only variable is
which IP range the connection lands on. (The MEL request returns Cloudflare
error 1034 — the zone is not served on that prefix — but the `cf-ray` still
names the colo that terminated it, which is the whole point.) The zone is on the
**Free** plan; confirm with

```
curl -sS "https://api.cloudflare.com/client/v4/zones?name=stripes.energy" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result[0].plan.name'
```

`traceroute` shows the shape of it: Melbourne → Adelaide → **Perth** → Telstra
Global submarine → Singapore, ~96 ms. Cloudflare has said publicly that it moved
Free-plan traffic off Telstra and Optus links because those carriers price
transit far above industry norms, and this path is exactly that decision made
visible.

Nothing in `wrangler.jsonc` can change it. Placement controls where the Worker
*executes*, never which colo *terminates* the connection — and a cache HIT never
executes the Worker at all yet still pays the full 0.3 s.

**What the cutover actually cost.** The *edge* got slower (Vercel `syd1` → a
Singapore entry colo) while the *origin* got ~25x faster (12.8 s → 0.5 s on a
cold cache). Cache HITs are the common case and are exactly the case placement
cannot help. Sized honestly that is ~1.4x on a realistic parallel page load, not
the ~4x a cold single `curl` suggests. Because it is a fixed per-round-trip tax,
the useful response is to *spend fewer round trips* — which is why hashed assets
are `immutable` and the font stylesheet is linked from the document head rather
than `@import`-ed (see § Static assets below).

**Why Workers Paid is still required.** The free plan caps CPU at **10 ms per
invocation, including cron invocations**, and 50 subrequests. Reads now fit
inside that easily (an R2 get and a stream). Builds never will: assembling one
year is ~50 units × 365 days of fill logic, and `/api/stats` folds 28 of them.
`wrangler.jsonc` sets `limits.cpu_ms: 300000`, which is a Paid-only setting. The
only way onto the free plan would be to build payloads outside Cloudflare and
upload them via the S3 API, making the Worker read-only.

---

## Why this is a store and not a warmer

This design exists because **a cron cannot warm Workers Cache**, and there is no
way around it. Cloudflare documents it:

> Other invocation types — scheduled (Cron Triggers), queue consumers,
> Workflows, Tail Workers, Durable Object invocations, Email Workers — always
> run without cache involvement.
>
> — [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)

The whole scheduled invocation runs with the cache bypassed, **including its
subrequests**. Four mechanisms were tried against the live deployment and all
failed for that one reason:

| Mechanism | Result |
|---|---|
| Module-level `exports.default.fetch` | sweep reports success; external requests still MISS |
| `ctx.exports.default.fetch` from `scheduled` | same |
| Plain outbound `fetch()` to the public hostname | 404 |
| Self service binding (`env.SELF.fetch`) | 404 |

Do not re-attempt these, or the `run_worker_first` variant. See
`docs/workers-behaviour-measured.md` § "Correction" for how a spike produced a
false positive on exactly this point — the prober warmed the thing it was
measuring.

**Bindings are not subject to that limitation.** A `scheduled` handler can write
to R2 normally. So rather than fight to keep a cache warm, the store makes a cold
cache cheap: what used to be a 12.8 s upstream fetch is now a ~10 ms R2 read.

Two things follow, both good:

- **`stale-while-revalidate` no longer matters.** Workers Cache does not honour
  it — an expired entry blocks and revalidates rather than serving stale
  (measured on Free and Paid). That used to mean one visitor per expiry paid
  3–9 s. Now the request that revalidates reads R2. The directive is still
  emitted, so behaviour improves by itself if Cloudflare ever ships it.
- **Purging is safe.** It costs one R2 read per year, not one upstream fetch.

The old `unreached` counter is gone. It existed to detect a warmer that reported
success while achieving nothing; the honest signal now is `x-cf-source` on a real
request, which is observable from outside and cannot be fooled by self-probing.

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
the work one at a time.

So the limits in `src/server/queued-oeclient.ts` (10 in flight, one start per
100 ms) are a **ceiling, not a target**. Note that this queue is scoped **per
fan-out**, not per isolate — see [Runtime traps](#runtime-traps-worth-knowing).
What now bounds concurrent pressure on OpenElectricity is the refresher's
`REFRESH_CONCURRENCY`, and the fact that almost nothing else ever calls them:
visitors read R2, not upstream.

(Caveat on the table: measured over a high-latency link, so the ratios between
rows are the signal, not the absolute seconds.)

---

## The client-side cache (TanStack Query)

`src/client/year-queries.ts` caches each year in TanStack Query, keyed
`['capFacYear', mode, year, CF_DTO_VERSION]`. The cached value is **not** raw
JSON — it is the fully pre-rendered `CapFacYear`, including the offscreen canvas
tiles (one `FacilityYearTile` per facility). `staleTime` matches the server tier,
and adjacent years are prefetched in the background.

`CF_DTO_VERSION` is in the key so a payload-shape change invalidates a tab that
has been open across a deploy. It replaced the old per-deploy build id, and this
is the one layer where a deploy genuinely changes nothing: a new Worker version
resets the *server* cache, but it cannot reach a browser that is already running
the previous build's JavaScript. Only a shape change should bust this one.

---

## The stats layer

`/stats` sits **on top of** everything above. `computeCoalStats`
(`src/server/coal-stats-service.ts`) reads each year from the store, 1999→current,
and reconstructs MWh from capacity factor × capacity × 24.

Normally that computation is **not on a request path at all**: the refresher
folds it and stores `v1/stats.json`, so `/api/stats` streams a precomputed object
(~11 ms). Only a cold bucket lands in `computeCoalStats`, which then takes ~40 s
and stores its result on the way out.

**There is no `?fleet=` parameter.** There used to be `full` and `current`, which
forked the cache entry and doubled the refresher's work for a payload nothing ever
requested — `/stats` has only ever asked for the full fleet, and a
records-since-1999 table without Hazelwood and Liddell in it would be missing the
point. `FleetMode` stays what it is elsewhere: a **client-side view selector**
over the capacity-factors roster, applied by `filterFleet`
(`src/shared/fleet-filter.ts`), appearing in the client's query key and in no
server URL or cache key.

One consequence worth remembering: a stats result is **only as fresh as the year
payloads it read**, which have their own independent tier lifetimes (an archive
year can be a week old). This is why the page states its own provenance — see
below.

---

## How old is the data?

Each year's payload carries `created_at` — the moment it was assembled from
OpenElectricity — and the route echoes it as `x-cf-built-at`. It travels **with
the body**, so a copy replayed from cache still reports its true age. That is the
honest answer to "how old is this?", and it is what `/stats` surfaces in its
`sources` block and what `/diagnostics` shows per year.

---

## Purging the cache

`POST /api/admin/purge`, authorised by `CACHE_SECRET` (its own secret, not the
cron token), or the button on `/diagnostics`.

```bash
curl -X POST https://stripes.energy/api/admin/purge \
  -H "Authorization: Bearer $CACHE_SECRET"
```

It purges the `capacity-factors`, `coal-stats` and `html` tags globally via
Cloudflare's Instant Purge, and clears the facilities-roster memo on whichever
isolate served the request. (`html` covers the SSR documents. A deploy already
orphans those by changing the cache key, so this is the escape hatch for when
that reasoning turns out to be wrong at 10 pm.)

**It does not touch R2**, deliberately — see [The layers](#the-layers). So a
purge is now cheap: the next request for each year refills the cache from an R2
read, not from OpenElectricity. It used to be the most expensive button in the
app.

The browser's own copy is unreachable by any purge, which is why the data routes
keep their browser `max-age` at 60 s.

---

## Diagnostics

**`/diagnostics`** has three sections:

- **Purge server cache** — the button described above.
- **Server cache health** — requests each year exactly as the visualisation does
  and reports Cloudflare's own `cf-cache-status` (`HIT` warm; `MISS`/`EXPIRED`
  means that request rebuilt it), plus `age` and `x-cf-built-at`. It is manual:
  probing ~28 years issues ~28 requests and, on a cold cache, makes you pay for
  them.
- **Client tile renders** — how long each canvas tile took to build in *this
  browser session*, from `tileTimingRecorder`. Also available as the Shift+P
  overlay. A hard refresh or a new tab starts empty.

This used to be much larger. `GET /api/diagnostics/tiles` probed every year
**twice** — once cache-busted at the origin, once plain at the edge — because
with four layers no single response could tell you which one had answered, and it
carried its own warm/cold classification thresholds. `cf-cache-status` reports
that directly, so the endpoint and its 143 lines are gone.

---

## Confirming caching works on prod

The thing to verify is no longer "is the cache warm?" — it is **"does a cold
cache cost an R2 read or an upstream fetch?"** Those are different questions, and
only the second one matters now.

```bash
# Purge first, then ask for a year from a client that has touched nothing.
curl -X POST https://stripes.energy/api/admin/purge -H "Authorization: Bearer $CACHE_SECRET"

curl -sS -o /dev/null -D - "https://stripes.energy/api/capacity-factors?year=2011" \
  | grep -iE 'cf-cache-status|x-cf-source|x-cf-built-at'
```

Pass is `cf-cache-status: MISS` **with** `x-cf-source: r2`, sub-second. That pair
is the whole design in one line: the cache was cold *and* nobody waited on
OpenElectricity. `x-cf-source: upstream` on an established year means the
refresher is not writing.

Ask twice and the second is a `HIT`, faster still, with the same
`x-cf-built-at`.

**Pick a year you have not already requested.** Probing warms what it measures —
that is precisely how the earlier cache-warmer conclusion went wrong (see
`docs/workers-behaviour-measured.md` § "Correction"). A second request from the
same client proves nothing about the first.

Worker logs (`wrangler tail`, or Workers Logs in the dashboard) carry the
`refresh` summary line each tick. In steady state `written` is 0 most ticks and
`failed` is always 0.

---

## Runtime traps worth knowing

Three things about workerd that are not obvious and have already cost time.

**A response with no `Cache-Control` is cached anyway.** There is no
"force-dynamic" equivalent. Anything that must not be cached needs an explicit
`Cache-Control: no-store` (`NO_STORE` in `cache-headers.ts`), which shows up as
`cf-cache-status: BYPASS`. Omitting the header does not decline to choose a
policy, it chooses one silently — which is how the SSR document came to be
cached across a deploy without anyone deciding it should be. It now sets its own
(`applyDocumentCacheHeaders`), so nothing we serve relies on this behaviour.

**A Worker cannot loop back to itself under miniflare** — which backs both
`vite dev` and `wrangler dev`. The runtime reads the self-request as a deadlock
and cancels the **whole request**, uncatchably. Nothing in the app does this any
more; the loopback module and its `CF_LOOPBACK` / `PUBLIC_ORIGIN` /
`__LOOPBACK_ENABLED__` switches were deleted along with the cache warmer they
existed to serve. Worth knowing before anyone reaches for the pattern again —
bindings (R2) work identically in dev and prod, self-fetches do not.

**Module-level state that produces promises or timers is unsafe.** Timers only
advance while the request that created them is alive, and promise continuations
that resolve in a different request context are cancelled. The OpenElectricity
queue was originally one module-level `p-queue` shared by the whole isolate;
on workerd that produced intermittent *"your Worker's code had hung and would
never generate a response"*. It is now scoped per fan-out via `withRequestQueue`.
The regression test lives in `src/server/__tests__/workerd/` and runs inside real
workerd — Node cannot express this failure, which is exactly why it reached
production-shaped code unnoticed.

---

## Analytics

**Cloudflare Web Analytics**, replacing Vercel's dashboard-injected analytics.
Free on every plan, cookieless (no consent banner), and it reports Core Web
Vitals (LCP/INP/CLS) alongside page views, referrers, paths and countries — so
it covers what Vercel Web Analytics *and* Speed Insights gave us.

**There is no analytics code in this repo, and there should not be.** The site
is configured in the dashboard (Analytics → Web Analytics → `stripes.energy`)
with RUM set to **Enable**, i.e. automatic injection: Cloudflare adds the
snippet at the edge for the proxied zone. Two reasons that is the right choice
over the manual snippet, both learned the hard way:

- **Automatic reports first-party**, to `/cdn-cgi/rum` on our own domain.
  The manual snippet reports to `static.cloudflareinsights.com`, which ad
  blockers routinely block — so manual quietly under-counts.
- **Only one snippet can render per page.** Automatic injection *and* a manual
  snippet is a bug, not redundancy: they report to different endpoints and
  produce two divergent data streams.

It follows that a beacon in `__root.tsx` would be actively harmful once the zone
is proxied. There is a comment there saying so.

**It started working at DNS cutover, not before** — automatic injection needs
the zone proxied through Cloudflare. Verified live: the page loads
`static.cloudflareinsights.com/beacon.min.js` and the beacon `POST`s to
first-party `/cdn-cgi/rum`, `204`. (Historical note, in case anyone reconsiders
turning RUM on early for a future migration: Cloudflare validates beacons by
**postfix-matching the configured hostname**, so a `stripes.energy` site accepts
`www.stripes.energy` but rejects `coal-stripes.simon-8e9.workers.dev`.)

**Checking it with `curl` will tell you it is broken. It is not.** Cloudflare
only injects when the *request* carries a browser-ish `Accept` header. `curl`
sends `Accept: */*` and gets the un-injected HTML; the identical URL with
`Accept: text/html` gets the beacon, ~359 bytes longer. User-Agent makes no
difference, and neither does cache status — the two variants are cached
separately and **both** report `cf-cache-status: HIT`, so there is no
cache-busting trick that reveals it either. The correct probe:

```bash
curl -sS -H 'Accept: text/html,application/xhtml+xml' https://stripes.energy/ \
  | grep -c cloudflareinsights          # 1 = injected, 0 = actually broken
```

One further sharp edge: automatic injection fails silently if a response carries
`Cache-Control: … no-transform`. Our HTML now sets a `Cache-Control`
(`public, max-age=0, s-maxage=3600`) and deliberately omits `no-transform` —
there is a unit test asserting it stays omitted, because `curl -I` cannot see
this break. Check it first if analytics ever goes quiet.

Server-side, `observability` is enabled in `wrangler.jsonc`, so Worker logs and
invocation metrics are in the dashboard under Workers → coal-stripes.

---

## Static assets

Everything above is about the *data* path. The JS and CSS take a different one:
they are Workers Static Assets, served from `dist/client` before the Worker
runs, and none of the `Cache-Control` in `src/server/cache-headers.ts` applies to
them.

Their default is `public, max-age=0, must-revalidate`. That is right for the
un-hashed files in `public/` (`favicon.svg`, `og-image.png` — stable URLs whose
contents can change) and wrong for `/assets/*`, where Vite content-hashes every
filename, so a URL there can never change meaning. Left at the default, a repeat
visit revalidated all seven modules the page needs — two stylesheets and five
JS chunks — before it could render. They come back `304` with no body, but on
this zone each one is still a ~300 ms round trip to Singapore.

`public/_headers` fixes it. It is copied verbatim into `dist/client` by Vite,
which is the assets directory the Cloudflare plugin hands to Wrangler.

**Only one `Cache-Control` rule, deliberately.** Matching rules are *merged*,
not overridden, and a repeated header is joined with a comma — so adding a `/*`
rule alongside `/assets/*` would emit
`Cache-Control: public, max-age=86400, public, max-age=31536000, immutable`
and the browser would honour the first `max-age`. Anything not matched keeps the
default, which is what the un-hashed files want anyway.

Two more round trips came out of the critical path in the same pass:

- **DM Sans is linked from the document head** (`src/routes/__root.tsx`), not
  `@import`-ed from `opennem.css`. An `@import` is discovered only after the
  importing sheet has downloaded *and* parsed, so the font CSS sat behind
  `opennem.css` in a serial chain — ~340 ms of dead time. `preconnect` to
  `fonts.gstatic.com` covers the second hop, which is otherwise not discovered
  until the font CSS parses.
- **Facility canvases carry their height as a JSX attribute**, resolved during
  render rather than in the paint effect (`src/components/CompositeTile.tsx`).
  A `<canvas>` with no `width`/`height` attributes is intrinsically 300×150, and
  with `width: 100%` CSS derives an aspect ratio from that — so the first painted
  frame laid every row out at half the container width, ~584 px instead of
  25–96 px, and the effect collapsed the page from ~17,600 px to ~1,900 px one
  frame later. That single reflow was **CLS 0.57**, i.e. the entire score.

Verifying all three:

```bash
# hashed asset — immutable; un-hashed public file — still revalidates
curl -sI https://stripes.energy/assets/<hashed>.js | grep -i cache-control
curl -sI https://stripes.energy/og-image.png      | grep -i cache-control

# font stylesheet present in the initial HTML, not behind opennem.css
curl -sS -H 'Accept: text/html' https://stripes.energy/ | grep -c fonts.googleapis.com
```

CLS is a browser measurement, so use a DevTools performance trace on a fresh
load, or a `PerformanceObserver` on `layout-shift` — `curl` cannot see it.
