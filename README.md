# Coal Stripes Visualisation

A reference app demonstrating the [OpenElectricity](https://openelectricity.org.au) API: a 'stripes' visualisation of the daily capacity factors of Australia's coal units, navigable day-by-day back to the start of facility-level NEM data in January 1999. A fleet-mode toggle switches between the full historical fleet (every unit that ever operated, including retired plants) and today's operating fleet; periods with no recorded data (e.g. WEM before 2006) render as "no data".

<div align="center">
<img src="coal-stripes-screenshot.png" alt="Coal Stripes Visualisation" width="80%">
</div>

## Overview

Each horizontal stripe is one coal generating unit; each pixel column is one day of the displayed 365-day window. Shading encodes the unit's daily capacity factor — light grey (25%) to black (100%) — with red marking days below 25% (effectively offline) and pale blue marking days with no data. Drag, scroll, or use the keyboard to slide the window across ~19 years of history.

## How this app uses the OpenElectricity API

This is the part the repo exists to demonstrate. The server (never the browser) talks to OpenElectricity via the official [`openelectricity`](https://www.npmjs.com/package/openelectricity) npm package, using two endpoints:

1. **Facilities** — fetch all operating coal units:
   `getFacilities({ status_id: ['operating'], fueltech_id: ['coal_black', 'coal_brown'] })`
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

5. Open [http://localhost:3000](http://localhost:3000)

## Architecture

There is a strict separation of concerns: the server holds the API key and talks to OpenElectricity; the client only ever talks to our own `/api/capacity-factors` route.

```
src/
├── app/                  # Next.js App Router
│   ├── page.tsx          # Main visualisation page
│   └── api/
│       ├── capacity-factors/  # The one data route the client uses
│       └── cron/              # Vercel Cron cache-warming endpoints
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

1. **Server**: each calendar year is cached via Next's data cache (`unstable_cache`) on a freshness tier — the current year revalidates hourly, recent years daily, the deep archive weekly (NEM data is revisable, so no year is treated as immutable) — plus CDN `Cache-Control` headers with stale-while-revalidate.
2. **Cron warming**: Vercel Cron (see `vercel.json`) re-warms the current year (hourly), recent years (daily), and the archive (weekly) via `src/server/cache-warmer.ts`, so an evicted entry is refilled before a user hits it.
3. **Client**: each year is cached with [TanStack Query](https://tanstack.com/query) (`src/client/year-queries.ts`) — the cached value is the fully pre-rendered set of canvas tiles — with adjacent years prefetched in the background.

Cache health can be inspected at any time from the **`/diagnostics`** page or `GET /api/diagnostics/tiles` — see the [caching doc](docs/caching-and-diagnostics.md).

Dates use `@internationalized/date` (not the built-in `Date`) throughout, with helpers in `src/shared/date-utils.ts` handling the NEM (AEST) and WEM (AWST) network timezones.

## Visualisation details

- **Capacity factor**: daily energy generation divided by the unit's theoretical maximum (registered capacity × 24 h), as a percentage.
- **Colour mapping** (`src/shared/capacity-factor-color-map.ts`): below 25% → red; 25–100% → linear light-grey-to-black ramp; no data → pale blue.
- **Rendering**: each year is painted once into an offscreen canvas (one pixel per unit-day); scrolling just re-slices those tiles, so navigation stays smooth.
- **Navigation**: drag or trackpad-scroll the stripes; arrow keys move by month (Shift = 6 months, Cmd/Ctrl = year boundaries); `T`/Home jumps to the present, `S` to the start of data; click a month label to jump there.

## Environment variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENELECTRICITY_API_KEY` | Your OpenElectricity API key | Yes |
| `CRON_SECRET` | Shared secret authorising the `/api/cron/warm-*` endpoints; Vercel Cron sends it automatically once set in the project's env vars | For deployed cron |
| `ENABLE_FILE_LOGGING` | Write request logs to `logs/` (default: on in development, off in production; keep off on serverless) | No |
| `DEBUG_OE` | Set to `1` for verbose server logging of fetches and cache hits | No |

## Testing

```bash
npm test                  # unit tests (offline, fast)
npm run test:integration  # hits the real OpenElectricity API — requires
                          #   OPENELECTRICITY_API_KEY in .env.local
npm run test:e2e          # Playwright browser tests of the gesture navigation
                          #   (starts the dev server; also needs the API key)
```

## Deployment

The app deploys to Vercel as-is (`vercel.json` configures the cron schedules and function timeouts). Set `OPENELECTRICITY_API_KEY` and `CRON_SECRET` in the project's environment variables, and leave `ENABLE_FILE_LOGGING` unset or `false`.

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
