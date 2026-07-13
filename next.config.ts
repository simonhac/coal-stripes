import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `build:local` sets NEXT_DIST_DIR=.next-build so a production build outputs
  // to a separate directory and doesn't clobber the dev server's .next dir.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
