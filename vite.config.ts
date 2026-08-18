import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(() => ({
  server: {
    // Conductor's @simon/workspace-env allocates this workspace 3010–3014 and
    // passes the choice through PORT. Vite doesn't read PORT on its own.
    port: Number(process.env.PORT) || 3010,
  },
  resolve: {
    alias: {
      // Mirrors the `@/*` path in tsconfig.json, which every file in src/ uses.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    // Puts the SSR environment in workerd for `vite dev`, so dev, test and prod
    // all run the same runtime.
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    // Compiles src/styles/app.css — the `@import 'tailwindcss'`, the
    // `@config` pointing at Open Electricity's theme, and the `@apply`s in the
    // base layer. Must run before start's plugin, which is what turns the
    // `?url` import in __root.tsx into the <link> the document ships.
    tailwindcss(),
    /**
     * `inlineCss` puts the stylesheet in the document instead of behind a
     * `<link>`, which deletes a whole round trip from the critical path.
     *
     * That trip is expensive here for a reason no amount of caching fixes: the
     * zone's edge is in Singapore (see CLAUDE.md), so ~300 ms is connection
     * latency, and the browser cannot even begin the request until it has parsed
     * the document naming it. Chrome measured the stylesheet as render-blocking
     * for 490 ms to deliver 10.8 KB — against a document that is already 58 KB
     * because it carries the unit metadata blob. At that ratio a second request
     * cannot win, which is the same argument that put the metadata inline
     * (@/client/unit-metadata-inline).
     *
     * Marked experimental upstream. The thing to re-check if it is ever bumped
     * is the `url(/assets/*.woff2)` references inside the sheet: they are
     * root-absolute so they survive being moved into a <style>, but that is the
     * failure mode the option's own `transformAssets` sub-option exists for.
     */
    tanstackStart({ server: { build: { inlineCss: true } } }),
    // react's plugin must come after start's plugin
    viteReact(),
  ],
}));
