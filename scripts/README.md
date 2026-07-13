# Scripts

Development utilities. None of these are part of the app; run them with `node scripts/<name>.js`.

## capture-og-image.js

Captures the OpenGraph preview image (`public/og-image.png`) from a running dev server using Puppeteer. Start `npm run dev` first.

## fetch-energy-data.js

Fetches sample energy data from the OpenElectricity website API and saves raw and processed copies under `output/` — handy for inspecting response shapes offline.

## test-api-caching.js

A manual test for the capacity-factors API caching behaviour.

1. Start the development server:
   ```bash
   npm run dev
   ```

2. In another terminal, run the test:
   ```bash
   node scripts/test-api-caching.js
   ```

It exercises current-year, previous-year, and future-year requests, verifies each year's cache headers and response structure, and prints request timings.
