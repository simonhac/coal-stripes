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
    tanstackStart(),
    // react's plugin must come after start's plugin
    viteReact(),
  ],
}));
