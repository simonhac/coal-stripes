# Moving coal-stripes to TanStack Start on Cloudflare Workers

> **Status: proposal / handoff.** Nothing here has been implemented. This document is
> written to be read cold — a fresh agent or a future you should be able to execute from it
> without the conversation that produced it.

## Why this exists

An earlier survey (`.context/plans/tanstack-survey-what-s-worth-adopting-in-coal-stri.md`)
rejected TanStack Start with:

> *"Would abandon the Vercel Data Cache + `unstable_cache` + cron-warmer architecture in
> `docs/caching-and-diagnostics.md` — the most carefully-tuned part of the system. Enormous
> cost, no user-visible gain."*

That verdict was correct **on Vercel**, and is now the wrong way round. The thing it was
protecting is precisely the thing Cloudflare deletes.

Cloudflare shipped **Workers Cache** in July 2026 (all plans): a regionally-tiered cache in
front of a Worker entrypoint, configured by ordinary `Cache-Control` headers, with request
collapsing, `stale-while-revalidate`, and tag-based purge. Every one of those is a
hand-built mechanism in this repo today.

Honest summary of what the move buys:

- **Simpler: yes, substantially** — and almost entirely because of Cloudflare, not TanStack
  Start. Roughly **1,200–1,600 lines of caching/warming/diagnostics infrastructure delete**,
  four cache layers become two, two crons become zero-or-one, and the two nastiest
  documented traps stop existing.
- **More modern: yes, modestly.** Vite instead of Turbopack/webpack, typed file-based
  routes, typed search params, one runtime (`workerd`) across dev/test/prod, Vitest.
- **Users: essentially no difference**, with a small win — the global upper tier and request
  collapsing beat today's Sydney-only edge warming on the rare cold path.

**Decided scope:** full migration — TanStack Start + Cloudflare Workers, plus the optional
cleanups (drop the inert Tailwind setup and the vestigial Geist fonts; Jest → Vitest with
`@cloudflare/vitest-pool-workers`), plus **Bun as package manager only**.

---

## 1. Why Cloudflare collapses the cache architecture

Today (per `docs/caching-and-diagnostics.md`), four layers with three separate invalidation
mechanisms:

| Layer | Today | On Workers Cache |
|---|---|---|
| Browser | `Cache-Control: public, max-age=60` | unchanged |
| CDN edge (Sydney only) | `Vercel-CDN-Cache-Control` + `Vercel-Cache-Tag` | **merged** — one tiered cache, upper tier global |
| Data Cache (origin) | `unstable_cache` tiers in `src/server/cf-cache.ts` | **merged** — same layer |
| OpenElectricity | ~3–9 s | unchanged |

Mechanisms that become unnecessary:

| Repo mechanism | Replaced by |
|---|---|
| `src/server/cf-cache.ts` — three `unstable_cache` tier wrappers, module-level singletons kept purely for cache-key identity (159 LOC) | one `Cache-Control: public, max-age=<tier>, stale-while-revalidate=<swr>` header |
| `inFlight` single-flight map (`src/server/cf-cache.ts:85`), needed because `unstable_cache` does **not** collapse concurrent misses | Workers Cache **does** collapse — one Worker invocation, streamed to all waiters |
| `&v=BUILD_ID` cache-buster (`src/shared/capacity-factors-url.ts`) and its four call sites | `Cache-Tag`-based purge (§2) |
| `revalidateTag` + `invalidateByTag` + the "purge and re-warm must be two requests" gotcha (`src/app/api/admin/purge/route.ts`, 218 LOC) | `ctx.cache.purge({ tags: [...] })`, available on every plan |
| The in-process-warm-vs-self-fetch split, and the "self-fetch warms the CDN, not the Data Cache" production failure (`src/server/cache-warmer.ts`) | one cache — nothing left to desynchronise |
| `regions: ["syd1"]` pinning and its three-part rationale | dissolves; the upper tier is global, so the first request anywhere warms everywhere |
| `swrSeconds` tier config that Vercel honours only at the edge | native `stale-while-revalidate` at both tiers |
| `/api/diagnostics/tiles` double-probe (143 LOC) + most of `/diagnostics` (508 LOC) | Workers Cache ships its own cache-status headers and observability |
| `/api/cron/warm-stats` (39 LOC) and most of `/api/cron/warm-all` (90 LOC) | see §3 — largely nothing |
| `src/server/request-logger.ts` — fs-backed daily log files (280 LOC) | structured `console` + Workers Logs / Logpush |

**Surviving unchanged:** the tier policy in `src/shared/config.ts` (`YEAR_CACHE_TIERS`,
`yearCachePolicy`) — it just feeds one header now; the OE queue and retry in
`src/server/queued-oeclient.ts`; all of `src/server/cap-fac-data-service.ts`.

---

## 2. Deploy-time cache behaviour — the idiomatic Cloudflare answer

**Set `cache.cross_version_cache: true`, and invalidate by DTO-version tag.**

Cloudflare's own guidance names this exact case:

> *"Advanced users who deploy frequently and whose responses do not change between most
> deployments should consider enabling `cross_version_cache`"* — it avoids throwing away a
> warm cache on every deploy.

This app deploys often for client/CSS changes while the year JSON almost never changes
shape. That is the described case.

The version-keyed default (Worker version is in the cache key ⇒ every deploy starts cold) is
tempting because it echoes the current `&v=BUILD_ID` intent, but it does not work here for a
specific reason:

> **Cron Triggers cannot warm Workers Cache.** *"Workers Caching only applies to HTTP
> requests handled by a `fetch` handler"* — scheduled invocations, Queue consumers,
> Workflows, Tail Workers and Durable Objects are all excluded, and *"a response is only
> cached once it has been served at least once."*

So version-keying would send 28 years genuinely cold on every deploy with no reliable refill
mechanism — a worse version of the trap this migration exists to remove.

The idiomatic replacement for `CF_CACHE_VERSION` / `&v=BUILD_ID` is a cache tag:

```ts
'Cache-Tag': `capacity-factors,cf-${tier},cf-year-${year},cf-dto-${CF_DTO_VERSION}`
```

When the DTO changes, bump `CF_DTO_VERSION` and purge that one tag. Cloudflare documents
exactly this ("version-based tagging strategies for selective invalidation"), with
`ctx.cache.purge({ purgeEverything: true })` as the blunt fallback. One constant survives
instead of a whole layer, and it can be wired into the deploy script so it isn't a thing to
remember.

Tag limits: printable ASCII only, ≤1,024 chars per tag, ≤1,000 tags per response,
case-insensitive.

---

## 3. Warming

With `cross_version_cache: true` plus `stale-while-revalidate`, only the *first ever*
request for a year is slow — not the first after each deploy. A stale year is served
instantly while it refreshes in the background.

**Start with no warmer at all.** Add one only if observability shows real cold reads.

If a warmer is wanted later it must be an outbound HTTP `fetch()` to the public hostname —
the cron's own invocation bypasses the cache by design.

> ⚠️ **Verify empirically that a Worker's subrequest to its own route re-enters Workers
> Cache rather than being short-circuited.** This is the direct analogue of the Vercel trap
> recorded in `docs/caching-and-diagnostics.md` and must not be assumed. If it doesn't work,
> warm from outside — e.g. a scheduled GitHub Action hitting the public URLs.

---

## 4. Why TanStack Start, and how little of the work it is

Be clear about the decomposition: **~90% of the benefit is Cloudflare; Start is the pleasant
remainder.** They are separable decisions.

The client is close to a free lift. Across ~7,800 lines of client + shared code, the entire
Next.js surface is:

- two `next/link` imports (`src/components/OpenElectricityHeader.tsx:3`,
  `src/app/diagnostics/page.tsx:4`)
- one `next/font/google` block in `src/app/layout.tsx` (being dropped — §6)
- one `process.env.NEXT_PUBLIC_BUILD_ID` (`src/shared/capacity-factors-url.ts:20`) — which
  this migration deletes anyway
- two `@vercel/*` analytics components

There is **no RSC boundary to unwind** — every page is `'use client'`; the only server
component is the 65-line `src/app/layout.tsx`. There is **no client routing at all**: zero
uses of `next/navigation`. The canvas pipeline (`src/client/facility-year-tile.ts`,
`src/components/CompositeTile.tsx`), the gesture spring, the shortcut registry, the
`window`-CustomEvent tooltip bus and TanStack Query v5 are vanilla React 19 that never knew
it was in a Next app.

What Start actually buys:

- **Typed search params** — replacing the hand-rolled mount-only `?fleet=` read +
  `history.replaceState` mirror at `src/app/page.tsx:245-256`, which exists only to dodge a
  hydration mismatch.
- Server routes co-located on the same Vite build and runtime.
- `head` management replacing the `metadata` export; prerendering the static shell; no
  `'use client'` ceremony.
- Already-aligned ecosystem: TanStack Query v5 is the app's entire data layer.

**Caveat to accept knowingly:** Start is **Release Candidate**, not stable 1.0
(feature-complete, API declared stable; RSC still experimental). Pin the version. Cloudflare
requires `@tanstack/react-start` v1.138.0+ for static prerendering.

---

## 5. Where Bun fits (and where it doesn't)

Bun sits at a different layer from the rest of this, so it's mostly orthogonal — but two of
the four places it could go are actively ruled out by the Cloudflare decision.

| Layer | Bun? | Why |
|---|---|---|
| **Package manager + script runner** | **Yes — adopt it** | `bun install`, `bun run`, `bunx wrangler`. No architectural commitment, real speed win on install, reversible in one command (`rm bun.lock && npm install`). This is the whole of Bun's fit here. |
| **Production runtime** | **No** | Cloudflare runs `workerd`. Bun and workerd are *alternative* runtimes, not layers — picking Cloudflare picks workerd. Deploying Start to a Bun server elsewhere is possible, but forfeits Workers Cache, which is the entire reason for the move. |
| **Bundler / dev server** | **No** | TanStack Start *is* a Vite plugin (`tanstackStart()`), and `@cloudflare/vite-plugin` is what puts the SSR environment in workerd during `vite dev`. Bun's bundler isn't on that path. |
| **Test runner** | **No** | This one matters. The plan picks Vitest for `@cloudflare/vitest-pool-workers`, which runs tests *inside workerd*. `bun test` runs inside Bun, so server tests would pass under a runtime the app never executes on — exactly the bug class this migration must catch (`fs`, `AsyncLocalStorage`, `p-queue` timer semantics). Splitting `bun test` for pure `src/shared/` tests and Vitest for the rest isn't worth two runners over ~4k lines. |

`@cloudflare/vitest-pool-workers` requires **Vitest 4.1+**.

So: adopt Bun in Phase 1 as the package manager, and nowhere else. Unlike Start and
Cloudflare, nothing else in this plan depends on the outcome.

---

## 6. Execution

### Spike first (half a day, before committing to any of it)

1. **`openelectricity@0.9.1` on `workerd`.** Good signs: one dependency (`dayjs`), ships
   `dist/browser/index.js` resolved via the `import`/`default` export conditions. Call
   `getFacilities` + `getFacilityData` from `wrangler dev`.
2. **`AsyncLocalStorage`** (`src/server/queued-oeclient.ts:10`, carries queue priority) —
   supported under `nodejs_compat`; verify.
3. **`p-queue` interval pacing** (`{ concurrency: 10, interval: 100, intervalCap: 1 }`) —
   Workers advance timers only while I/O is pending; fine within a request, but verify.
4. **Workers Cache end-to-end** — MISS→HIT on the second request, `swr` serving instantly
   past `max-age`, `ctx.cache.purge({ tags })` actually evicting.
5. **`fs`/`path` static import** in `src/server/request-logger.ts`, pulled in at module scope
   by `src/app/api/capacity-factors/route.ts:30` — breaks bundling regardless of the
   `ENABLE_FILE_LOGGING` gate. Must be rewritten, not gated.

**If 1–3 fail, stop.** The migration isn't viable without them.

### Phase 1 — scaffold

`bunx create-cloudflare@latest --framework=tanstack-start` in a scratch dir; switch the repo
to `bun install` / `bun run`. Port into the repo alongside the existing Next app:

- `vite.config.ts` — `cloudflare({ viteEnvironment: { name: 'ssr' } })` + `tanstackStart()`
  + `viteReact()`
- `wrangler.jsonc` — `nodejs_compat`, `main: "@tanstack/react-start/server-entry"`,
  `cache: { enabled: true, cross_version_cache: true }`

Secrets (`OPENELECTRICITY_API_KEY`, `CACHE_SECRET`) become Worker secrets, read via
`import { env } from 'cloudflare:workers'`. Note `.env.local` is where they live today; see
also the 1Password/Vercel secret plumbing already in place.

### Phase 2 — server (where the budget goes)

~3,000 lines of `src/server/` + routes, a large slice of it deletion.

- Delete `src/server/cf-cache.ts`; the route calls `CapFacDataService` directly and sets
  `Cache-Control` + `Cache-Tag` from `yearCachePolicy()`.
- Rewrite `src/server/request-logger.ts` as structured `console` output (no `fs`); delete
  root `instrumentation.ts`.
- Port the six `route.ts` handlers to Start server routes — all are plain `Request` →
  `NextResponse.json` → `Response.json`.
- Delete `src/app/api/cron/*`, `src/app/api/diagnostics/tiles/route.ts`,
  `src/server/cache-warmer.ts`; reduce `src/app/api/admin/purge/route.ts` to a
  `ctx.cache.purge({ tags })` call.
- Keep `src/server/cap-fac-data-service.ts` (599 LOC) and `src/server/coal-stats-service.ts`
  (511 LOC) unchanged.

### Phase 3 — client

Three routes (`/`, `/stats`, `/diagnostics`) as file routes; `src/app/layout.tsx` → root
route + `head`; two `next/link` → TanStack Router `Link`; `?fleet=` becomes a typed search
param on the index route (deleting the `replaceState` mirror). Components, hooks,
`src/client/` and `src/shared/` move untouched. Drop `@vercel/analytics` and
`@vercel/speed-insights` (Cloudflare Web Analytics if wanted).

### Phase 4 — cleanups

- **Drop Tailwind** (`tailwindcss`, `@tailwindcss/postcss`, `postcss.config.mjs`). It is
  inert — no CSS file imports it, so the utility classes in `OpenElectricityHeader.tsx`
  render nothing today. **Confirm visually before deleting**, then fold those classes into
  `src/app/opennem.css`.
- **Drop `next/font/google` Geist/Geist_Mono** — vestigial from `create-next-app`; the real
  body font is DM Sans, `@import`ed in `opennem.css`.
- **Jest → Vitest.** The suite uses plain `ts-jest`, not `next/jest`, so `src/shared/` and
  `src/client/` tests port almost mechanically. Add `@cloudflare/vitest-pool-workers` for
  real `workerd` server tests, replacing the integration test that currently spawns
  `next dev` via `child_process`.
- **Delete** `vercel.json`, `next.config.ts`, `.eslintrc.json` (`next/core-web-vitals`),
  `next-env.d.ts`, `.vercelignore`, and the `next` tsconfig plugin.
- **Rewrite `docs/caching-and-diagnostics.md`** — most of it describes machinery that no
  longer exists. Also fix the stale `README.md`: it still documents the removed per-tier
  crons (`warm-current`/`warm-recent`/`warm-archive`) and the wrong `status_id` filter (the
  code now requests `['operating','retired']`).

### Phase 5 — cutover

Run both deployments in parallel on a subdomain until parity, then move DNS.

---

## 7. Verification

- Port the unit suite first (it is framework-agnostic) so `src/shared/` and `src/client/`
  stay green throughout the move.
- `e2e/gestures.spec.ts` (Playwright) is the acceptance test for the client lift — only
  `webServer.command` changes. Beware the known cross-workspace `:3000` collision; run on a
  free port via a throwaway `.context` config.
- **Data parity — the decisive check.** For every year 1999–2026, diff the new deployment's
  `/api/capacity-factors?year=<y>` against
  `https://stripes.energy/api/capacity-factors?year=<y>`. Same upstream, so they must match
  modulo `created_at`. Payloads are ~190–250 KB of plain JSON (measured live: 177 KB for
  2024, 249 KB for 1999), so a byte-level diff is cheap.
- **Cache correctness.** Probe each year twice against the preview deployment and assert the
  cache-status header flips MISS→HIT; assert a response past `max-age` returns instantly
  (`swr`); assert `purge({ tags: ['cf-dto-vN'] })` evicts.
- **Watch OE call volume** during the first day — with request collapsing and `swr` it
  should be *lower* than today's 10-minute sweep of 28 years.

---

## 8. Scale, for budgeting

~11k LOC non-test, ~4k LOC test.

| Area | LOC | Migration cost |
|---|---|---|
| Client React (components, hooks, `src/client/`, client pages) | 5,933 | near-free lift |
| Shared / isomorphic (`src/shared/`) | 1,875 | one `process.env` reference |
| CSS (`opennem.css` + `globals.css`) | 1,339 | unchanged |
| Server runtime (`src/server/`) | 2,243 | **the work** — and much of it deletion |
| API routes (6 × `route.ts`) | 730 | rewrite, several deleted outright |
| Server component (`layout.tsx`) | 65 | → root route + `head` |
| Tests | 4,116 | mechanical Jest → Vitest |

---

## Sources

- [Your Worker can now have its own cache in front of it](https://blog.cloudflare.com/workers-cache/)
- [Workers Cache — configuration (`cross_version_cache` guidance)](https://developers.cloudflare.com/workers/cache/configuration/)
- [Workers Cache — limitations (cron/scheduled excluded; no pre-warming)](https://developers.cloudflare.com/workers/cache/limitations/)
- [Workers Cache — cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [TanStack Start overview (Release Candidate)](https://tanstack.com/start/latest/docs/framework/react/overview)
- [Deploy TanStack Start to Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)
