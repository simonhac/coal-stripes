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

Objects store the **serialised response bytes**, with `builtAt` in
`customMetadata`. That is what lets the read path do `new Response(object.body)`
— 180 KB of JSON is streamed without ever being parsed, and `x-cf-built-at` is
read from metadata rather than from the body.

`wrangler.jsonc` runs `*/10 * * * *` into the `scheduled` handler in
`src/worker.ts`, which calls `refreshAll()` (`src/server/store-refresher.ts`).
Each tick:

1. `HEAD` each of the 28 years, compare `builtAt` against the year's tier, and
   rebuild only what is due. Most ticks write nothing.
2. If any year was rewritten — **or** the stored stats payload is missing or a
   day old — refold `/api/stats` and store it. Order matters: stats fold the
   year payloads, so doing it first would fold the previous generation.

   The age condition is a backstop, not decoration. Without it, a tick that
   rewrites years and *then* fails the fold would leave every later tick seeing
   an unchanged set of years, so the stats object would stay missing until some
   visitor paid ~40 s to rebuild it.

Watch the `refresh` log line: `{written, skipped, failed, statsWritten, totalMs}`.

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

**Before DNS cutover, weigh this:** `stripes.energy` on Vercel is served from
`syd1` today. Moving to Workers on a Free zone routes Australian visitors via
Singapore, making the *edge* slower even though the *origin* got ~25x faster
(12.8 s → 0.5 s on a cold cache). Cache HITs are the common case and they are
exactly the case placement cannot help. Size the regression honestly, though:
~1.4x on a realistic parallel page load, not the ~4x a cold single request
shows. That is a plan/BGP question,
not a code one.

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
has been open across a deploy. It replaced the old per-deploy build id: deploys
now deliberately keep their caches, and only a shape change should bust them.

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

It purges the `capacity-factors` and `coal-stats` tags globally via Cloudflare's
Instant Purge, and clears the facilities-roster memo on whichever isolate served
the request.

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
`cf-cache-status: BYPASS`.

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

**It starts working at DNS cutover, not before.** Automatic injection needs the
zone proxied through Cloudflare, and today `stripes.energy` is DNS-only,
pointing at Vercel. Nor can the current `workers.dev` deployment be made to
report into this site: Cloudflare validates beacons by **postfix-matching the
configured hostname**, so `stripes.energy` accepts `www.stripes.energy` and
`blog.staging.stripes.energy` but rejects `coal-stripes.simon-8e9.workers.dev`.
(Tempting idea that does not survive that rule: turning RUM on early to gather
real Core Web Vitals as evidence for the Singapore-routing question above. It
would need a second Web Analytics site for the workers.dev hostname and a
token swap at cutover — not worth it.)

One sharp edge to know: automatic injection fails silently if a response carries
`Cache-Control: … no-transform`. Our HTML sets no `Cache-Control` at all, so we
are fine — but check it if analytics ever goes quiet.

Server-side, `observability` is enabled in `wrangler.jsonc`, so Worker logs and
invocation metrics are in the dashboard under Workers → coal-stripes.
