# Caching & tile-render diagnostics

This app should (almost) never make a user wait on OpenElectricity. Upstream
fetches are slow — rate-limited, retried, and fanned out across the NEM and WEM
networks — so a genuinely cold request can take several seconds. Several layers
of caching keep that cost off the critical path, and a small diagnostic surface
lets you confirm they are doing their job.

- [Caching layers](#caching-layers)
  - [1. Server — Next.js Data Cache + CDN](#1-server--nextjs-data-cache--cdn)
  - [2. Cron warming](#2-cron-warming)
  - [3. Client — TanStack Query](#3-client--tanstack-query)
- [Tile-render diagnostics](#tile-render-diagnostics)
  - [`GET /api/diagnostics/tiles`](#get-apidiagnosticstiles)
  - [The `x-cf-cold` marker](#the-x-cf-cold-marker)
  - [The `/diagnostics` page](#the-diagnostics-page)
  - [Client tile-timing recorder & the Shift+P overlay](#client-tile-timing-recorder--the-shiftp-overlay)
- [Confirming caching works on prod](#confirming-caching-works-on-prod)
- [Known limitations](#known-limitations)

---

## Caching layers

Data is fetched, cached, and rendered one **calendar year per request** — a
year is the unit everything is keyed on. The earliest year is 2006.

### 1. Server — Next.js Data Cache + CDN

`src/app/api/capacity-factors/route.ts` is the only data route the browser
calls. It wraps the upstream fetch in Next's Data Cache (`unstable_cache`) and
also sets CDN `Cache-Control` headers, so a warm year is served either from the
regional CDN edge or from the origin's Data Cache without touching
OpenElectricity.

NEM data is revisable (January can revise the December just past), so **no year
is treated as immutable**. Instead each year sits in one of three freshness
**tiers**, defined once in `src/shared/config.ts` (`yearCachePolicy`) and shared
by both the server route (`revalidate` + `Cache-Control`) and the client
(`staleTime`):

| Tier | Years (today) | `revalidate` | `stale-while-revalidate` |
|------|---------------|--------------|--------------------------|
| `current` | the current year | 1 hour | 1 day |
| `recent` | the last 5 past years | 1 day | 7 days |
| `archive` | everything older | 7 days | 30 days |

`stale-while-revalidate` means a warmed entry is served **instantly, even when
stale**, while it refreshes in the background — so users never feel a cold
fetch as long as an entry exists.

### 2. Cron warming

The Data Cache is per-deployment and can be evicted, so an entry can go missing
after a deploy (which wipes it) or under memory pressure. Rather than let an
unlucky user pay the cold fetch, Vercel Cron (`vercel.json`) re-warms every year
on a frequent schedule via `src/server/cache-warmer.ts` (`warmYears`):

| Cron | Schedule | Warms |
|------|----------|-------|
| `warm-all` | every 10 min | every year, back to 2006 |

`warm-all` sweeps the whole span every 10 minutes so **no year — in any tier —
stays cold for longer than the cron interval**, whether it went cold from
eviction or a fresh deploy. That is cheap: warming an already-warm year is just a
Data-Cache read (no OpenElectricity call), so only genuinely cold years do real
work — a full warm sweep is ~21 Data-Cache reads. The frequent cadence does not
make data fresher (that is set by `revalidate`); it only shrinks the post-deploy
cold window, which is exactly when a visitor could hit a cold fetch. A single
warmer covers the current year too, so no separate `warm-current` is needed.
Each warm self-fetches the **public** route (no `Authorization` header) so it
populates both the Data Cache and the CDN edge. The cron route is gated by
`CRON_SECRET` (`isAuthorisedCronRequest`), which Vercel Cron attaches
automatically — **if `CRON_SECRET` is unset in the Vercel project, every cron
fails closed (401) and nothing is warmed.**

### 3. Client — TanStack Query

`src/client/year-queries.ts` (`yearQueryOptions`) caches each year in TanStack
Query, keyed `['capFacYear', year]`. The cached value is **not** raw JSON — it
is the fully pre-rendered `CapFacYear`, including the offscreen canvas tiles
(`createCapFacYear` → one `FacilityYearTile` per facility). `staleTime` matches
the server tier, and adjacent years are prefetched in the background
(`usePrefetchAdjacentYears`). The browser only ever talks to our own route,
never to OpenElectricity.

---

## Tile-render diagnostics

Two questions motivated this tooling: *is cron caching actually working on
prod?*, and *how long does each tile take to render?* The pieces below answer
both.

### `GET /api/diagnostics/tiles`

Probes each year in a range (default 2006→current) and reports, per year, how it
was served. Implemented as a read-only sibling of the cache warmer
(`probeYears` in `src/server/cache-warmer.ts`).

Parameters:

- `?years=2006-2026` — inclusive range (max 30 years).
- `?year=2024` — a single year.
- no params — the full span.

It is left **public** (no `CRON_SECRET`): it only re-exercises the already-public,
CDN-cached `/api/capacity-factors` route, so it adds no attack surface a caller
doesn't already have — and that lets the `/diagnostics` page read it without a
secret in the browser.

Example:

```bash
curl -s "https://stripes.energy/api/diagnostics/tiles?years=2024-2026" | jq '.summary'
```

```jsonc
{
  "yearsProbed": 3,
  "warm": 3, "cold": 0, "uncertain": 0, "failed": 0,
  "slowestYear": 2025, "slowestMs": 620,
  "totalMs": 1541,
  "allWarm": true          // the one-line "is cron caching working?" verdict
}
```

Each `tiles[]` entry carries `tier`, `ms`, `classification`
(`warm` | `cold` | `uncertain`), and the raw signals (`xVercelCache`, `age`,
`coldFetch`, `coldFetchMs`).

**How a year is classified** (honest, in order of trust):

1. `x-vercel-cache: HIT` or `age > 0` → **warm** (the CDN edge served a cached
   copy). Trusted first, because an edge HIT replays whatever `x-cf-cold` was
   cached with the original response, which may be stale.
2. `x-cf-cold` header (below) → **cold** if `true`, **warm** if `false`. This is
   the definitive per-request signal whenever the request reached the function.
3. Latency fallback (no CDN / no marker, e.g. local dev): `≤ 1500 ms` → warm,
   `≥ 3000 ms` → cold, otherwise `uncertain`.

### The `x-cf-cold` marker

`src/app/api/capacity-factors/route.ts` records, per instance, every time its
wrapped fetch runs — which only happens on a Data-Cache **miss**, i.e. a genuine
cold OpenElectricity fetch. It then emits two headers on each response:

- `x-cf-cold: true|false` — did **this** request pay a cold fetch?
- `x-cf-cold-ms: <n>` — how long that cold fetch took (when `true`).

Because the marker travels on the same response, it is robust to Vercel's
per-instance memory (unlike aggregate counts) and correctly reports "warm" for
`stale-while-revalidate` background refreshes (the user was served instantly).

```bash
curl -sI "https://stripes.energy/api/capacity-factors?year=2006" | grep -i 'x-cf-cold\|x-vercel-cache'
```

### The `/diagnostics` page

`src/app/diagnostics/page.tsx` is a client page with two tables:

- **Server cache health** — a per-year view of `GET /api/diagnostics/tiles`,
  with a headline warm/cold verdict and a "Re-probe" button.
- **Client tile renders** — every tile render in this browser session, with its
  duration and an AEST timestamp.

Client render times live **only** in the browser's heap (there is no server
persistence), so the client table populates as you navigate the visualisation
and is only visible in the same tab: `<Link>`-navigate from `/` to `/diagnostics`
and the timings carry over; a hard refresh or a new tab starts empty (the page
shows a note explaining this). The server table loads regardless.

### Client tile-timing recorder & the Shift+P overlay

`src/client/tile-timing-recorder.ts` is a small in-browser singleton (a bounded
ring buffer with pub/sub) that records three kinds of render:

| Kind | What it measures | Instrumented in |
|------|------------------|-----------------|
| `tile-build` | one facility's canvas for one year | `createCapFacYear` loop |
| `year-build` | all facility tiles for a year | `createCapFacYear` |
| `fetch-build` | end-to-end: network fetch + parse + build | `yearQueryOptions` queryFn |

Network overhead ≈ `fetch-build − year-build`. The same records feed the
**Shift+P** debug overlay's *Timing* tab (a live in-session view), while
`/diagnostics` is the shareable, side-by-side view — both read the same
singleton.

---

## Confirming caching works on prod

```bash
# Headline verdict — expect "allWarm": true shortly after the crons run.
curl -s https://stripes.energy/api/diagnostics/tiles | jq '.summary'

# Spot-check the start year by hand.
curl -sI "https://stripes.energy/api/capacity-factors?year=2006" \
  | grep -i 'x-vercel-cache\|x-cf-cold\|age'
```

Note that `x-vercel-cache: MISS` on a first hit is **not** a cache failure — it
only means the CDN edge in *your* region was cold. If the response still returns
in well under a second (and `x-cf-cold: false`), a warm origin Data Cache served
it, which is exactly what the crons maintain.

---

## Known limitations

- **`maxDuration`**: `vercel.json` applies a 60 s default to all `src/app/api/**`
  functions, and the two long-running routes (`warm-all`, `/api/diagnostics/tiles`)
  need the full 300 s for a fully-cold all-years run (e.g. the first sweep after a
  deploy). Both the route-segment exports (`maxDuration = 300`) *and* explicit
  per-route `functions` entries in `vercel.json` declare 300 s, so the resolved
  limit does not depend on route-segment-vs-glob precedence.
- **Post-deploy cold window**: a deploy wipes the Data Cache, so years stay cold
  until the next `warm-all` run — up to the cron interval (≤ 10 min), plus the
  sweep itself: a fully-cold ~21-year sweep runs sequentially and takes ~60–90 s,
  so the tail years clear a little after the earlier ones. A user hitting a year in
  that window pays one cold fetch (now ~3–4 s after the shortened retry backoff, not
  ~15 s). Closing this fully would need deploy-triggered warming.
- **Start-edge prefetch**: adjacent-year prefetch tries `startYear-2..-1`, which
  at 2006 are out of range and skipped — so a jump straight to the start year is
  always an on-demand fetch with no prefetch overlap.
- **Per-instance history**: the `x-cf-cold` *per-request* signal is authoritative,
  but any aggregate cold-fetch counts kept in module memory are per-serverless
  instance and best-effort.
