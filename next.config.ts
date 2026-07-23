import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `build:local` sets NEXT_DIST_DIR=.next-build so a production build outputs
  // to a separate directory and doesn't clobber the dev server's .next dir.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  env: {
    // Per-deploy id inlined into the client bundle (NEXT_PUBLIC_ ⇒ browser-visible).
    // The client appends it as `&v=` on tile fetches so each deploy rotates the
    // request URL, busting the browser + Vercel-edge HTTP caches (both keyed on
    // the URL, max-age 24h) — without touching the origin Data Cache (keyed on
    // year/mode/version, not the URL), so a fix reaches users immediately with no
    // extra OpenElectricity fetch. Falls back to a stable `dev` off-Vercel.
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? "dev",
  },
};

export default nextConfig;
