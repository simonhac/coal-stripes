# What Cloudflare Workers actually does — measured

Evidence gathered before and during the migration off Vercel, against a live
throwaway Worker. Kept because several of these contradict what the docs (and
our own migration proposal) led us to expect, and because the two that bit
hardest — `stale-while-revalidate` and the shared queue — are the kind of thing
you would otherwise rediscover the expensive way.

For how the app uses all this, see
[caching-and-diagnostics.md](caching-and-diagnostics.md).

## The spike — 2026-08-07

Worker: `coal-stripes-spike` → https://coal-stripes-spike.simon-8e9.workers.dev
Account: `simon holmes à court` (8e917720506dd95a4e9c41b03ca55830), **Free plan at time of test**.
Wrangler 4.119.0, `compatibility_date: 2026-08-01`, `nodejs_compat`,
`cache: { enabled: true, cross_version_cache: true }`.

## Verdict: GO. Every blocker cleared.

| # | Question | Result |
|---|---|---|
| 1 | `openelectricity@0.9.1` on workerd | **PASS.** `getFacilities` authenticated and returned in 1,139 ms. |
| 1b | Which build resolves under `nodejs_compat`? | **`dist/browser/index.js`** — the clean ESM build, *not* the CJS node build. The exports-order worry does not materialise. Bundle 87 KiB / 21 KiB gzip, startup 15 ms. |
| 2 | `AsyncLocalStorage` | **PASS**, all four cases: sync read, survives `await`, nested shadow+restore, `undefined` outside a `run`. |
| 3 | `p-queue` interval pacing (**the** blocker) | **PASS, exactly.** `{concurrency:10, interval:100, intervalCap:1}` × 12 tasks → start offsets `0,100,200,…,1100`. Works **with and without** I/O in flight — the workerd timer caveat did not bite. |
| 4 | Workers Cache MISS→HIT | **PASS.** 878 ms MISS → 312 ms HIT, identical body. |
| 5 | Query string in the cache key | **PASS.** `?year=1999` is a separate entry from `?year=2024`. |
| 6 | `cache.purge({ tags })` | **PASS.** `{"success":true,"errors":[]}`. |
| 7 | `cross_version_cache` | **PASS** (observed accidentally): after a redeploy, the previous version's entry was still served. |
| 8 | Loopback via `ctx.exports.<Named>` | **PASS.** 542 ms MISS → **6 ms / 4 ms / 3 ms** HIT. |
| 9 | Loopback via `ctx.exports.default` warms the **public** key | **PASS.** Warmed year → external HIT 304 ms; never-warmed control → MISS 892 ms. |
| 10 | Warming from a **cron** `scheduled` handler | **WRONG — recorded as a pass, and it is not. See the correction at the end.** |
| 11 | `stale-while-revalidate` | **FAIL — see below.** |

## The one negative result: `stale-while-revalidate` is not honoured

Three header shapes, all identical behaviour — the first request after `s-maxage`
lapses **blocks and revalidates** (`cf-cache-status: EXPIRED`, full 500 ms paid);
`STALE` and `UPDATING` never appeared.

```
public, max-age=10, s-maxage=30, stale-while-revalidate=300   → EXPIRED, 0.81s
public,             s-maxage=20, stale-while-revalidate=600   → EXPIRED, 0.81s
public, max-age=20, s-maxage=20, stale-while-revalidate=600   → EXPIRED, 0.87s
```

Steady-state cycle observed by polling every 5 s: `EXPIRED (0.82s)` → `HIT` for
the TTL → `EXPIRED`.

**Re-tested on Workers Paid (same day, after upgrade): identical.** `EXPIRED`,
0.90 s and 0.81 s, for both header shapes. So this is *not* a plan restriction —
Workers Cache does not serve stale for these directives as of 2026-08-07.

**Consequence for the migration:** the migration proposal argued for running
*no warmer at all*, on the strength of swr serving stale instantly. **That
argument is dead.** A
warmer is mandatory — without one, the first visitor after every `s-maxage`
lapse pays the full cold OpenElectricity fetch (3–9 s), which is exactly the
problem the Vercel cron exists to solve.

**But this is cheap to absorb**, because items 9 and 10 make the warmer trivial:

```ts
async scheduled(_event, _env, ctx) {
  for (const year of years) {
    const res = await ctx.exports.default.fetch(
      new Request(`https://stripes.energy/api/capacity-factors?year=${year}`));
    await res.arrayBuffer();
  }
}
```

That is *one* mechanism replacing `src/server/cache-warmer.ts` (420 LOC) and its
in-process-vs-self-fetch split — and the "self-fetch warms the CDN, not the Data
Cache" trap cannot recur, because there is only one cache.

## Two incidental findings worth carrying into the port

1. **A response with no `Cache-Control` gets cached anyway.** Today's routes rely
   on `export const dynamic = 'force-dynamic'`; on Workers, every
   must-not-be-cached response needs an explicit `Cache-Control: no-store`.
   Verified: `no-store` → `cf-cache-status: BYPASS`.
2. **Fetching a Cloudflare-fronted host from a Worker trips error 1042.** Hit
   this with `https://cloudflare.com/cdn-cgi/trace`. Irrelevant for
   `api.openelectricity.org.au`, but it is why in-Worker loopbacks must use
   `ctx.exports`, not a plain `fetch()` to our own hostname.
3. `GET /` on a `workers.dev` subdomain returned 500 without invoking the Worker
   at all (empty tail). Platform quirk; routes under a path are unaffected.

## Reproducing

The probe Worker is not in the repo (it lived in a gitignored scratch dir), but
it was a single file exposing one route per question. To redo any of this:

```bash
# a bare wrangler Worker with cache.enabled + cross_version_cache
bunx wrangler deploy
B=https://coal-stripes-spike.simon-8e9.workers.dev
curl -sS $B/als; curl -sS $B/pqueue; curl -sS $B/oe
curl -sS $B/cached?year=2024   # twice — MISS then HIT
curl -sS $B/loopback?k=$RANDOM # twice — inner MISS then inner HIT
curl -sS "$B/warm?year=X" && curl -sS -D- -o/dev/null "$B/cached?year=X"
curl -sS $B/purge
```

`limits.cpu_ms` is commented out in `wrangler.jsonc` — the Free plan rejects it
(`code: 100328`). Re-enable on Paid.


---

## Afterwards: the one that got away

The spike tested `p-queue` **inside a single request** and it paced perfectly.
It never tested the queue **across** requests — and the real app shares one
module-level queue for the whole isolate. That fails on workerd two ways at once:
timers stop advancing when their creating request ends, and promise continuations
resolving in another request context get cancelled. The symptom was intermittent
*"your Worker's code had hung and would never generate a response"* under
ordinary page load, well after the spike had said GO.

The lesson is about the shape of the test, not the runtime: **a single-request
test cannot see a cross-request bug.** The fix (`withRequestQueue`) and its
regression test now live in `src/server/__tests__/workerd/`, running in real
workerd rather than Node.

Cloudflare's `no_handle_cross_request_promise_resolution` compatibility flag was
tried and rejected: it silences the warning without fixing the timer deadlock,
and would have hidden the diagnostic that located the problem.


---

## Correction: cron triggers cannot warm the cache

Item 10 was recorded as a PASS. It is not. Cloudflare documents the opposite,
plainly:

> Other invocation types — scheduled (Cron Triggers), queue consumers,
> Workflows, Tail Workers, Durable Object invocations, Email Workers — always
> run without cache involvement.
>
> — [Workers Cache limitations](https://developers.cloudflare.com/workers/cache/limitations/)

The whole scheduled invocation runs with the cache bypassed, and that applies to
the subrequests it makes. Four mechanisms were tried against the live
deployment — module-level `exports.default`, `ctx.exports.default` from the
scheduled handler, a plain outbound `fetch()` to the public hostname, and a self
service binding — and all failed for this one documented reason.

**How the spike produced a false positive.** The evidence was a poll sequence
after a cron tick:

```
t=0.857s status=EXPIRED @21:20:05
t=0.312s status=HIT age=5 @21:20:11
```

That `EXPIRED` request was the prober's own. It rebuilt the entry and
repopulated it; every HIT afterwards was caused by the probe, not by the cron.
The cron's log line separately showed a `cf-cache-status`, which looked like
corroboration and was not. Two signals, one cause.

The lesson is the one this migration keeps teaching: **the only valid test of a
warmer is a request the warmer did not make, from a client that has touched
nothing.** Otherwise the probe warms the very thing it claims to measure.

Note also that `docs/cloudflare.md` — the original migration proposal — stated
this limitation correctly, and it was "corrected" away on the strength of the
spike. The docs were right and the experiment was wrong.
