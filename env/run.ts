#!/usr/bin/env npx tsx
/**
 * Conductor workspace RUN — starts the Next.js dev server
 * (wired in .conductor/settings.local.toml as `npx tsx env/run.ts`).
 *
 * Port: uses CONDUCTOR_PORT when Conductor provides it (so parallel workspaces
 * never collide), otherwise the first free port from 3000. The chosen port is
 * exported as PORT, which both `next dev` and instrumentation.ts's request
 * logger read.
 *
 * Pre-flight: bails if node_modules is missing; warns (but does not block) if
 * OPENELECTRICITY_API_KEY is absent, since the app then loads with no data.
 */
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const API_KEY = "OPENELECTRICITY_API_KEY";

const paint = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const Y = paint("33"), G = paint("32"), R = paint("31"), D = paint("2");

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(): Promise<number> {
  const base = Number(process.env.CONDUCTOR_PORT) || 3000;
  for (let p = base; p < base + 10; p++) {
    if (await portFree(p)) return p;
  }
  return base; // fall back — next dev will surface the conflict
}

function envHasKey(key: string): boolean {
  const p = resolve(ROOT, ".env.local");
  return existsSync(p) && new RegExp(`^${key}=.+`, "m").test(readFileSync(p, "utf-8"));
}

async function main(): Promise<void> {
  if (!existsSync(resolve(ROOT, "node_modules"))) {
    console.error(R("✗ node_modules missing — run setup first: npx tsx env/setup.ts"));
    process.exit(1);
  }
  if (!envHasKey(API_KEY)) {
    console.log(Y(`⚠ ${API_KEY} not in .env.local — the app will load but show no data.`));
    console.log(D("  Fix: vercel env pull .env.local   (or add the key manually)"));
  }

  const port = await pickPort();
  console.log(G(`▶ starting dev server on http://localhost:${port}`));
  try {
    execSync("npm run dev", {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
    });
  } catch {
    // Ctrl+C / non-zero exit — exit quietly
  }
}

main();
