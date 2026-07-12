#!/usr/bin/env npx tsx
/**
 * Conductor workspace SETUP — runs once when a workspace is created
 * (wired in .conductor/settings.local.toml as `npx tsx env/setup.ts`).
 *
 * Phases:
 *   1. Dependencies   — npm install (idempotent; skipped if node_modules present).
 *   2. Vercel env     — link this worktree to the `coal-stripes` project and pull
 *                       the development env (OPENELECTRICITY_API_KEY) into .env.local
 *                       so the app can load real data locally. Skipped gracefully if
 *                       the Vercel CLI is missing / not logged in, or in a cloud workspace.
 *   3. Validation     — confirm node_modules + the API key are in place.
 *
 * Idempotent and safe to re-run by hand. Use `npx tsx env/setup.ts --force`
 * to force a reinstall / re-link / re-pull.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VERCEL_PROJECT = "coal-stripes";
const API_KEY = "OPENELECTRICITY_API_KEY";
const force = process.argv.includes("--force");
const isCloud = process.env.CONDUCTOR_IS_LOCAL === "0";

// minimal ANSI colour helpers
const paint = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const Y = paint("33"), G = paint("32"), R = paint("31"), D = paint("2");

function run(cmd: string, { allowFail = false } = {}): boolean {
  console.log(D(`==> ${cmd}`));
  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
    return true;
  } catch {
    if (!allowFail) throw new Error(`command failed: ${cmd}`);
    return false;
  }
}

function hasVercelCli(): boolean {
  try {
    execSync("vercel --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function envHasKey(key: string): boolean {
  const p = resolve(ROOT, ".env.local");
  return existsSync(p) && new RegExp(`^${key}=.+`, "m").test(readFileSync(p, "utf-8"));
}

// 1. dependencies -----------------------------------------------------------
if (existsSync(resolve(ROOT, "node_modules")) && !force) {
  console.log(D("node_modules present — skipping npm install (use --force to reinstall)."));
} else {
  run("npm install");
}

// 2. Vercel link + env pull (local only) ------------------------------------
if (isCloud) {
  console.log(D("Cloud workspace (CONDUCTOR_IS_LOCAL=0) — skipping Vercel link / env pull."));
} else if (!hasVercelCli()) {
  console.log(Y("⚠ vercel CLI not found — skipping env pull."));
  console.log(D("  Install `npm i -g vercel`, then: vercel link && vercel env pull .env.local"));
} else {
  const linked = existsSync(resolve(ROOT, ".vercel", "project.json"));
  if (!linked || force) run(`vercel link --yes --project ${VERCEL_PROJECT}`, { allowFail: true });
  if (!envHasKey(API_KEY) || force) {
    run("vercel env pull .env.local --yes", { allowFail: true });
  } else {
    console.log(D(`.env.local already has ${API_KEY} — skipping env pull.`));
  }
}

// 3. validation -------------------------------------------------------------
console.log();
const okDeps = existsSync(resolve(ROOT, "node_modules"));
const okKey = envHasKey(API_KEY);
console.log(okDeps ? G("✓ dependencies installed") : R("✗ node_modules missing"));
console.log(
  okKey
    ? G(`✓ ${API_KEY} present in .env.local`)
    : Y(`⚠ ${API_KEY} not found — the app will run but can't load data until it's set`)
);
console.log();
