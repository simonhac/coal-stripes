# Coal Stripes Visualisation

A reference app demonstrating the [OpenElectricity](https://openelectricity.org.au) API: a 'stripes' visualisation of the daily capacity factors of Australia's coal units, navigable day-by-day back to the start of facility-level NEM data on 7 December 1998 — a few days before the market itself began trading, and a partial day at that. A fleet-mode toggle switches between the full historical fleet (every unit that ever operated, including retired plants) and today's operating fleet; periods with no recorded data (e.g. WEM before 2006) render as "no data".

<div align="center">
<img src="coal-stripes-screenshot.png" alt="Coal Stripes Visualisation" width="80%">
</div>

## Overview

Each horizontal stripe is one coal generating unit; each pixel column is one day of the displayed 365-day window. Shading encodes the unit's daily capacity factor — light grey (20%) to black (100%) — with red marking days below 20% (effectively offline) and pale blue marking days with no data. Drag, scroll, or use the keyboard to slide the window across ~19 years of history.

## How this app uses the OpenElectricity API

This is the part the repo exists to demonstrate. The server (never the browser) talks to OpenElectricity via the official [`openelectricity`](https://www.npmjs.com/package/openelectricity) npm package, using two endpoints:

1. **Facilities** — fetch all operating coal units:
   `getFacilities({ status_id: ['operating', 'retired'], fueltech_id: ['coal_black', 'coal_brown'] })`
   (retired units are included so the historical fleet is complete; the client filters them out for the "current fleet" view)
2. **Facility time series** — fetch daily energy per unit, one calendar year per request:
   `getFacilityData(network, facilityCodes, ['energy'], { interval: '1d', dateStart, dateEnd })`

Daily energy (MWh) is then converted to a capacity factor: `(energy / 24h) / registered_capacity`. A null reading means "no data" and is never conflated with 0 (a unit that ran but generated nothing).

Suggested reading order:

| File | What it shows |
|------|---------------|
| `src/server/queued-oeclient.ts` | Wrapping the OpenElectricity SDK with rate limiting and retries |
| `src/server/cap-fac-data-service.ts` | The two API queries, and turning energy into capacity factors |
| `src/app/api/capacity-factors/route.ts` | Serving the data to the browser with layered caching |
| `src/client/year-queries.ts` | The client fetching from our route (never OpenElectricity directly) |
| `src/shared/types.ts` | The JSON contract between our server and client |

## Getting Started

### Prerequisites

- Node.js 18+
- An OpenElectricity API key — free from [openelectricity.org.au](https://openelectricity.org.au)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/simonhac/coal-stripes-viz.git
   cd coal-stripes-viz
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create your environment file and add your API key:
   ```bash
   cp .env.example .env.local
   ```

4. Run the development server:
   ```bash
   npm run dev
   ```

5. Open [http://localhost:3010](http://localhost:3010) (Vite picks up `PORT` if set)

## Architecture

There is a strict separation of concerns: the server holds the API key and talks to OpenElectricity; the client only ever talks to our own `/api/capacity-factors` route.

```
src/
├── routes/               # TanStack Start file routes (pages + server routes)
│   ├── index.tsx         # Main visualisation page
│   ├── stats.tsx         # Whole-of-history records
│   ├── diagnostics.tsx   # Cache + render diagnostics
│   ├── api.capacity-factors.ts  # The one data route the client uses
│   ├── api.stats.ts
│   ├── api.admin.purge.ts
│   ├── api.admin.rebuild.ts  # Force one R2 data file to be rebuilt
│   └── api.admin.store.ts    # What's in the store, from HEADs
├── worker.ts             # Worker entry: Start's fetch handler + the cron
│                         #   `scheduled` handler
├── server/               # Server-only: OpenElectricity client, data service,
│                         #   cache warming, request logging
├── client/               # Client-only: year data vendor, pre-rendered
│                         #   canvas tiles
├── components/           # React components (stripes, labels, tooltip, axis)
├── hooks/                # Gesture/keyboard navigation, tooltip behaviour
└── shared/               # Framework-free logic used by both sides: config,
                          #   date utils, request queue, LRU cache, physics
```

Data flows through three layers of caching so users (almost) never wait on OpenElectricity — see **[Caching & tile-render diagnostics](docs/caching-and-diagnostics.md)** for the full picture, including how to confirm the caches are warm:

1. **Server**: Cloudflare **Workers Cache** sits in front of the Worker, configured entirely by the `Cache-Control` and `Cache-Tag` headers each route sets (`src/server/cache-headers.ts`). Years are cached on a freshness tier — current hourly, recent daily, deep archive weekly (NEM data is revisable, so no year is treated as immutable). Concurrent misses for the same year are collapsed into one origin call.
2. **The R2 store**: every year's payload also lives in the `DATA` bucket, where nothing expires, so a cache miss costs an R2 read rather than a 3–9 s OpenElectricity fetch. A `scheduled` handler rebuilds each year on its tier's schedule and purges the edge tags it changed (`src/server/store-refresher.ts`, `src/server/refresh-schedule.ts`). This is a *store*, not a warmer: Cloudflare runs scheduled invocations without cache involvement, so no cron can warm Workers Cache by any means — the fix is to make a miss cheap instead.
3. **Client**: each year is cached with [TanStack Query](https://tanstack.com/query) (`src/client/year-queries.ts`) — the cached value is the fully pre-rendered set of canvas tiles — with adjacent years prefetched in the background.

The **`/diagnostics`** page is one table: every file in the R2 store, how old it is, and a **Flush** button per row (plus Flush all). Flushing re-fetches that file from OpenElectricity, rewrites it and clears the edge cache, updating the row as it goes. See the [caching doc](docs/caching-and-diagnostics.md).

Dates use `@internationalized/date` (not the built-in `Date`) throughout, with helpers in `src/shared/date-utils.ts` handling the NEM (AEST) and WEM (AWST) network timezones.

## Visualisation details

- **Capacity factor**: daily energy generation divided by the unit's theoretical maximum (registered capacity × 24 h), as a percentage.
- **Colour mapping** (`src/shared/capacity-factor-color-map.ts`): below 20% → red; 20–100% → linear light-grey-to-black ramp; no data → pale blue.
- **Rendering**: each year is painted once into an offscreen canvas (one pixel per unit-day); scrolling just re-slices those tiles, so navigation stays smooth.
- **Navigation**: drag or trackpad-scroll the stripes; arrow keys move by month (Shift = 6 months, Cmd/Ctrl = year boundaries); `T`/Home jumps to the present, `S` to the start of data; click a month label to jump there.

## Environment variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENELECTRICITY_API_KEY` | Your OpenElectricity API key | Yes |
| `CACHE_SECRET` | Shared secret authorising `POST /api/admin/purge` and `POST /api/admin/rebuild`, and the Flush buttons on `/diagnostics`. It gets typed by hand, so it is deliberately not reused anywhere else | For the Flush buttons |
| `ENABLE_FILE_LOGGING` | Historical name; now just toggles structured request logging to the console. Set `false` to silence | No |
| `DEBUG_OE` | Set to `1` for verbose server logging of fetches and cache hits | No |

## Testing

```bash
npm test                  # unit + workerd tests (offline, fast)
npm run test:workers      # just the workerd suite, run inside the real runtime
npm run test:integration  # hits the real OpenElectricity API — requires
                          #   OPENELECTRICITY_API_KEY in .env.local
npm run test:e2e          # Playwright browser tests of the gesture navigation
                          #   (starts the dev server; also needs the API key)
```

Tests run under [Vitest](https://vitest.dev). Most run in Node, but the `workers`
project runs inside **workerd** via `@cloudflare/vitest-pool-workers` — that is
where runtime-specific behaviour (timers, per-request promise contexts) is
pinned, and Node cannot substitute for it.

## Deployment

The app deploys to **Cloudflare Workers**, automatically. Merging to `main`
triggers a [Workers Build](https://developers.cloudflare.com/workers/ci-cd/builds/):
Cloudflare watches the repo, runs `bun run build`, then `wrangler deploy`. There
is no API token in the repo and no deploy workflow to maintain — the build
settings live in the Cloudflare dashboard (Workers & Pages → `coal-stripes` →
Settings → Build). Only `main` is built; pull requests get no preview
deployment.

The manual path still works, and is the escape hatch if the integration is ever
down:

```bash
npm run deploy            # vite build && wrangler deploy
```

Pull requests are gated by `.github/workflows/ci.yml`, which runs typecheck,
lint and the offline tests. It does not deploy — Actions reports, Workers Builds
ships.

`wrangler.jsonc` configures Workers Cache, the R2 bucket, the 10-minute refresh
cron and the raised CPU limit, and Workers Builds reads it exactly as a laptop
deploy would. `OPENELECTRICITY_API_KEY` and `CACHE_SECRET` are Worker secrets
(`wrangler secret put …`), not environment variables — Workers Builds does not
manage them, and `wrangler deploy` leaves them alone. The build itself needs no
secrets. Workers Paid is required: the free plan caps CPU at 10 ms and
subrequests at 50, and `/api/stats` needs more of both.

## Contributing

This is a demonstration project showing integration with OpenElectricity's API and design patterns. Feel free to fork and adapt for your own visualisations.

## Author

Created by Simon Holmes à Court [@simonhac](https://github.com/simonhac)

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

- [OpenElectricity](https://openelectricity.org.au) for API access and design inspiration
- [@nc9](https://github.com/nc9) for the OpenElectricity client library and loving curation of OE's backend
- Australian Energy Market Operator (AEMO) for underlying electricity market data
- Next.js team for the excellent development framework
- [Anthropic Claude Code](https://claude.ai/code) for development assistance and code generation
