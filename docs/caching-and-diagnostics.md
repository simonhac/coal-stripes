# Caching & tile-render diagnostics

The whole point of this document: **nobody looking at the site should ever wait
on OpenElectricity.** Asking them for a year of coal data takes several seconds.
Everything below exists so that a person never pays that, and so that we can
check, at any moment, whether it is working.

- [What happens when you load a year](#what-happens-when-you-load-a-year)
- [Where the data comes from (dev and prod)](#where-the-data-comes-from-dev-and-prod)
- [The layers](#the-layers)
- [Freshness tiers](#freshness-tiers)
- [Keeping it warm: the cron warmer](#keeping-it-warm-the-cron-warmer)
- [Why the warmer is not optional](#why-the-warmer-is-not-optional)
- [Why we don't just ask OpenElectricity faster](#why-we-dont-just-ask-openelectricity-faster)
- [The client-side cache (TanStack Query)](#the-client-side-cache-tanstack-query)
- [The stats layer](#the-stats-layer)
- [How old is the data?](#how-old-is-the-data)
- [Purging the cache](#purging-the-cache)
- [Diagnostics](#diagnostics)
- [Confirming caching works on prod](#confirming-caching-works-on-prod)
- [Runtime traps worth knowing](#runtime-traps-worth-knowing)

---

## What happens when you load a year

The browser asks our own Worker for `/api/capacity-factors?year=2024`. It never
talks to OpenElectricity — the API key lives only on the server.

1. **Cloudflare Workers Cache** answers if it holds that year. The Worker does
   not run at all. This is the normal case, and it is the whole game.
2. On a miss, the Worker runs, `CapFacDataService` fetches from OpenElectricity
   (3–9 s), and the response is stored according to its `Cache-Control` header.
   Concurrent misses for the same year are **collapsed**: Cloudflare runs the
   Worker once and streams the one response to everybody waiting.
3. The client caches the result again — as pre-rendered canvas tiles, not JSON.

---

## Where the data comes from (dev and prod)

There is **no** dev/mock/staging data source. In every environment the data comes
from the **production OpenElectricity API**
(`https://api.openelectricity.org.au/v4`, keyed by `OPENELECTRICITY_API_KEY`).

`npm run dev` runs the whole app — routes included — in **workerd**, via the
Cloudflare Vite plugin, on the same host and port as the client. The one thing
dev does not have is Workers Cache: it exists only on deployed Workers. So in dev
every request is a cold fetch, and `/api/stats` reads its 28 years directly from
`CapFacDataService` rather than through the cache (see
[Runtime traps](#runtime-traps-worth-knowing)).

Because dev and prod share the same upstream, a data anomaly seen in dev will
match prod — compare with
`curl https://stripes.energy/api/capacity-factors?year=2024`.

---

## The layers

Two, where there used to be four.

| Layer | Lifetime | Purgeable? |
|---|---|---|
| Browser HTTP cache | `max-age=60` | **No** — which is why it is kept short |
| Cloudflare Workers Cache | `s-maxage` per freshness tier | Yes, by tag |
| *(OpenElectricity)* | 3–9 s, and no reader should ever reach it | n/a |

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
are naturally separate entries.

**There is no URL cache-buster.** Under the old Vercel setup the URL carried
`&v=BUILD_ID` so a deploy would rotate it; that was needed because three layers
could disagree about which deploy's payload shape they held. Here,
`cross_version_cache` is on precisely so entries **survive** deploys, and shape
changes are invalidated by bumping `CF_DTO_VERSION` (`src/shared/config.ts`) and
purging that tag.

---

## Freshness tiers

`YEAR_CACHE_TIERS` in `src/shared/config.ts`. NEM data is revisable — January can
revise the December just past — so no year is treated as immutable.

| Tier | Years | `s-maxage` |
|---|---|---|
| `current` | this year | 1 hour |
| `recent` | the last 5 | 1 day |
| `archive` | everything older | 1 week |

Future years are `Cache-Control: no-store` — the data does not exist yet.

---

## ⚠️ The warmer does not currently work in production

**Status 2026-08-08: unresolved, and a blocker for DNS cutover.**

The cron fires, sweeps all 28 years plus both stats modes, and reports
`{"log":"warm-all","rebuilt":30,"failed":0}` — yet an external `curl` for a year
the sweep just rebuilt still returns `cf-cache-status: MISS`. The warmer is
populating cache entries **nobody reads**.

Three mechanisms have been tried against the deployed Worker, all with the same
result:

| Mechanism | Result |
|---|---|
| Module-level `exports.default.fetch` from `cloudflare:workers` | sweep succeeds, external requests still MISS |
| `ctx.exports.default.fetch` from the `scheduled` handler | same |
| Plain outbound `fetch()` to the public hostname | same |

External requests themselves cache correctly (`MISS` → `HIT`), purge works, and
`cross_version_cache` works — so the cache is fine. It is specifically
**in-Worker requests that do not populate the key public traffic reads.**

The likely cause is **Workers Assets**: TanStack Start uploads a static-asset
bundle, so public requests are routed through an assets-aware wrapper, and
`exports.default` is a different entrypoint — and the cache key includes the
entrypoint. The bare probe Worker used during the spike had no assets, which is
why warming appeared to work there and does not here.

**Until this is resolved the site has no warmer**, and because Workers Cache does
not honour `stale-while-revalidate` (below), the first visitor after each TTL
boundary pays a full 3–9 s OpenElectricity fetch. That is a regression against
the Vercel setup and must be fixed before cutover.

The most likely fix is to warm from **outside** the Worker entirely — a
scheduled GitHub Action, or a second Worker, hitting the public URLs. Being a
genuinely external client is the only way to guarantee it takes the same path a
visitor does, which is the property that has failed here twice in two different
architectures.

---

## Keeping it warm: the cron warmer

`wrangler.jsonc` runs `*/10 * * * *` into the `scheduled` handler in
`src/worker.ts`, which calls `warmAll()` (`src/server/cache-warmer.ts`). That
sweeps every year plus both `/api/stats` modes.

The mechanism is the interesting part. A scheduled invocation is **never itself
cached** — Cloudflare excludes non-`fetch` handlers by design. So the warmer
reaches the cache by **looping back into the Worker's own fetch entrypoint**:

```ts
await exports.default.fetch(new Request(url));   // cloudflare:workers
```

That is a fresh, cacheable invocation, and it populates the very same key public
traffic reads. It must be `exports.default` — the cache key includes *which
entrypoint served the request*, so looping into a named entrypoint would warm a
key nobody reads.

A sweep of already-warm years is a handful of cache hits, so this is cheap.
Watch `rebuilt` in the `warm-all` log line: in a steady state it should be near
zero.

---

## Why the warmer is not optional

**Workers Cache does not honour `stale-while-revalidate`.** We emit the
directive, and it does nothing: when an entry lapses, the next request *blocks*
while it is rebuilt (`cf-cache-status: EXPIRED`) rather than being served stale.
Tested on three header shapes, on both the Free and Paid plans.

So without the warmer, the first visitor after every `s-maxage` boundary pays a
full 3–9 s OpenElectricity fetch. The cron interval must stay comfortably shorter
than the shortest tier window (`current`, one hour).

The `stale-while-revalidate` directive is left on the responses deliberately, so
the behaviour improves by itself if Cloudflare ever ships it.

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
What now bounds concurrent pressure on OpenElectricity is Workers Cache
collapsing duplicate misses, plus the warmer's own `WARM_CONCURRENCY`.

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
has been open across a deploy. It replaced the old per-deploy build id: deploys
now deliberately keep their caches, and only a shape change should bust them.

---

## The stats layer

`/stats` sits **on top of** everything above. `computeCoalStats`
(`src/server/coal-stats-service.ts`) reads `/api/capacity-factors` once per year,
1999→current, and reconstructs MWh from capacity factor × capacity × 24. The
result is cached for a day by `/api/stats`'s own headers.

Crucially it reads those years **through the cache**, by the same
`exports.default` loopback the warmer uses — so a warm year costs a few
milliseconds. It must not be switched to calling `CapFacDataService` directly:
that bypasses the cache and a rebuild would pay ~28 cold upstream fetches.

Two consequences worth remembering:

- A stats result is **only as fresh as the year payloads it read**, which have
  their own independent tier lifetimes (an archive year can be a week old). This
  is why the page states its own provenance — see below.
- After a purge, the years are all cold, so a `/stats` rebuild is slow. Let the
  warmer refill first.

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

It purges the `capacity-factors` and `coal-stats` tags globally via Cloudflare's
Instant Purge, and clears the facilities-roster memo on whichever isolate served
the request.

One request does it. The old Vercel endpoint needed **two** — purge, then re-warm
— because `revalidateTag` also discarded entries written later in the same
request, so a bundled re-warm was thrown away on return. Workers Cache has no
such behaviour, and the warmer refills within ten minutes anyway.

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

```bash
# Ask twice; the second should be a HIT and much faster.
for i in 1 2; do
  curl -sS -o /dev/null -D - "https://stripes.energy/api/capacity-factors?year=2024" \
    | grep -iE 'cf-cache-status|age|x-cf-built-at'
done
```

Expect `MISS` (or `EXPIRED`) then `HIT`, with the same `x-cf-built-at` both
times. A `HIT` on the first try is the normal steady state — the warmer got there
first.

Worker logs (`wrangler tail`, or Workers Logs in the dashboard) carry the
`warm-all` summary line each sweep; `rebuilt` near zero means the cache is
holding.

---

## Runtime traps worth knowing

Three things about workerd that are not obvious and have already cost time.

**A response with no `Cache-Control` is cached anyway.** There is no
"force-dynamic" equivalent. Anything that must not be cached needs an explicit
`Cache-Control: no-store` (`NO_STORE` in `cache-headers.ts`), which shows up as
`cf-cache-status: BYPASS`.

**A Worker cannot loop back to itself under miniflare** — which backs both
`vite dev` and `wrangler dev`. The runtime reads the self-request as a deadlock
and cancels the **whole request**, uncatchably. So the decision is made up front
by `loopbackAvailable()` (`src/server/loopback.ts`) and local dev reads years
directly instead: slower, never wrong. Deployed, the loopback works and is fast.

**Module-level state that produces promises or timers is unsafe.** Timers only
advance while the request that created them is alive, and promise continuations
that resolve in a different request context are cancelled. The OpenElectricity
queue was originally one module-level `p-queue` shared by the whole isolate;
on workerd that produced intermittent *"your Worker's code had hung and would
never generate a response"*. It is now scoped per fan-out via `withRequestQueue`.
The regression test lives in `src/server/__tests__/workerd/` and runs inside real
workerd — Node cannot express this failure, which is exactly why it reached
production-shaped code unnoticed.
