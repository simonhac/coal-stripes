# House rules

- Always use Australian English spellings such as colour, visualise, optimise instead of American English spellings (eg. color, visualize and optimize). If you see American English spelling in my code, suggest a change.

- This project has a strong separation of concerns between the client and the server.
- The server talks to OpenElectricity using the OpenElectricityClient library.
- The client never talks directly to OpenElectricity, only to our server.

- **Where dev gets its data:** there is **no** dev/mock/staging data source. In
  every environment the data ultimately comes from the **production
  OpenElectricity API** (`https://api.openelectricity.org.au/v4`, keyed by
  `OPENELECTRICITY_API_KEY` in `.env.local`; the SDK falls back to prod unless
  `OPENELECTRICITY_API_URL` is set, which it is not). `npm run dev` runs the app
  under **workerd** via the Cloudflare Vite plugin, so dev, test and prod share
  one runtime, and `/api/capacity-factors` is served **in-process, same
  host/port** as the app. Because dev and prod share the same upstream, a data
  anomaly seen in dev will match prod (see
  `curl https://stripes.energy/api/capacity-factors?...`).

  The dev-vs-prod difference is the **R2 store**: plain `wrangler dev` gets a
  *local, empty* `DATA` bucket, so the first request falls through to a cold,
  rate-limited OpenElectricity fetch and needs the API key. `wrangler dev
  --remote` binds the **real** bucket instead, which is the quick way to drive
  the real UI with real data (and works without the OE key, since reads are
  satisfied from R2).

- **Caching, in one breath:** three layers stand between a reader and
  OpenElectricity — (1) their browser, 60 s; (2) **Workers Cache**, which
  answers at the edge; (3) **R2** (the `DATA` binding), whose objects never
  expire and which is therefore the *floor* — a miss below the cache costs an R2
  read, not the 3–9 s OpenElectricity fetch that no reader should ever pay. A
  cron rebuilds R2 every 10 minutes. Note it does **not** warm the cache:
  Cloudflare excludes scheduled invocations from Workers Cache entirely, which
  is precisely why this is a store and not a warmer. Full explanation:
  `docs/caching-and-diagnostics.md`.

- **Australian traffic enters Cloudflare at Singapore**, not Sydney — the zone is
  on the Free plan, whose shared `104.21.x`/`172.67.x` prefixes are not routed to
  an Australian PoP. It costs ~300 ms on every request, cache hit or miss, and no
  Worker setting can change it (`placement` controls where the Worker *executes*
  — confirmed `remote-SYD` — never which colo terminates the connection). Don't
  re-diagnose it as a code problem; the evidence is in
  `docs/caching-and-diagnostics.md` § Where the Worker actually runs. The useful
  response is to spend fewer round trips.

- When a generating unit is inoperable (due to maintenance or outages) its capacity factor will be zero, not null/undefined.
- When a capacity factor is unknown — either because the associated date is in the future or, for dates in the past, the data collection infrastructure is faulty — this is always represented as null.
- Never interpret null as zero or vice versa. Null means "no data"; zero is a zero quantity. These are distinct concepts and must never be swapped.

- Except where necessary (ie. interfacing external code), do not use the built-in JavaScript Date object. Use Adobe's @internationalized/date, and note that we have many date functions in src/shared/date-utils.ts.

- Environment variables are defined and stored in `.env.local`.

- The production deployment is at **https://stripes.energy**, a Cloudflare Worker
  (`coal-stripes`) attached by a *route*, not a custom domain — see the comment
  in `wrangler.jsonc`. Use it for prod checks — e.g.
  `curl -sS -D - https://stripes.energy/api/capacity-factors?year=2006 -o /dev/null`
  to inspect `cf-cache-status`, `age`, `cf-ray` (the trailing code is the entry
  colo) and `cf-placement` (where the Worker ran). `curl` defaults to
  `Accept: */*`; send `Accept: text/html` when checking anything about the HTML,
  or you will get a different, un-analytics-injected variant.

- When searching code, prefer ast-grep for syntax-aware and structural matching (eg. `ast-grep --lang typescript -p '<pattern>'`) instead of text-only tools like rg or grep.

## Gesture library notes (@use-gesture, react-spring)

- @use-gesture's `velocity` is a speed, always >= 0. Multiply by `direction` (-1/0/1) to get the true velocity vector: `velocity[0] * direction[0]`.
- Prefer `api.start({ ..., immediate: true })` over `api.set()` — `set()` has known bugs where the spring's internal value isn't updated and it "jumps back". Use `start()` with a spring config (no `immediate`) for animated transitions after release.
- `immediate: true` doesn't cancel queued animations; call `api.stop()` first to truly halt at the current position.
- In controlled gesture components, the parent's `currentOffset` prop is the source of truth. Internal refs may only track position *during* an active gesture; always initialise a new gesture (drag start, wheel start) from the parent's `currentOffset`, never a stored ref, or the position goes stale after keyboard navigation or data loads.
