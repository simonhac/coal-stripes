#!/usr/bin/env npx tsx
/**
 * Conductor workspace SETUP — runs once when a workspace is created
 * (wired in .conductor/settings.local.toml as `npx tsx env/setup.ts`).
 *
 * Phases:
 *   1. Dependencies   — npm install (idempotent; skipped if node_modules present).
 *   2. Vercel link    — link this worktree to the `coal-stripes` project (deploys
 *                       only; env does NOT come from Vercel). Skipped gracefully if
 *                       the Vercel CLI is missing, or in a cloud workspace.
 *   3. 1Password env  — `op inject` .env.local from the committed .env.tpl
 *                       (references into the coal-stripes-dev vault). 1Password is
 *                       the single source of truth for env vars; Vercel is a sync
 *                       target managed by the infra repo (config/coal-stripes.json).
 *                       Auth: OP_SERVICE_ACCOUNT_TOKEN, else the Keychain item
 *                       op-sa-coal-stripes-dev, else a personal op session.
 *   4. Validation     — confirm node_modules + the API key are in place.
 *
 * Idempotent and safe to re-run by hand. Use `npx tsx env/setup.ts --force`
 * to force a reinstall / re-link / re-inject.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VERCEL_PROJECT = "coal-stripes";
const API_KEY = "OPENELECTRICITY_API_KEY";
// macOS Keychain item holding the 1Password service-account token scoped to the
// coal-stripes-dev vault (read-only). Created once with:
//   security add-generic-password -U -a "$USER" -s op-sa-coal-stripes-dev -w
const KEYCHAIN_OP_SA = "op-sa-coal-stripes-dev";
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

// 2. Vercel link (deploys only — env comes from 1Password) -------------------
if (isCloud) {
  console.log(D("Cloud workspace (CONDUCTOR_IS_LOCAL=0) — skipping Vercel link."));
} else if (!hasVercelCli()) {
  console.log(Y("⚠ vercel CLI not found — skipping link (only needed for deploys)."));
} else {
  const linked = existsSync(resolve(ROOT, ".vercel", "project.json"));
  if (!linked || force) run(`vercel link --yes --project ${VERCEL_PROJECT}`, { allowFail: true });
  else console.log(D("Already linked to Vercel project."));
}

// 3. 1Password env (op inject from .env.tpl) ---------------------------------
// Auth order: OP_SERVICE_ACCOUNT_TOKEN in env → dev SA token from the macOS
// Keychain → ambient personal op session. Conductor runs setup non-interactively,
// so the Keychain path is what makes fresh worktrees self-bootstrap. The token
// is passed only into the op child process env — never printed or written out.
function opToken(): string | undefined {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return process.env.OP_SERVICE_ACCOUNT_TOKEN;
  try {
    const t = execSync(`security find-generic-password -s ${KEYCHAIN_OP_SA} -w`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

if (!envHasKey(API_KEY) || force) {
  const token = opToken();
  // SA tokens are account-bound; the personal-session fallback needs OP_ACCOUNT
  // pinned because two 1Password accounts exist on this machine.
  const opEnv = token
    ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token }
    : { ...process.env, OP_ACCOUNT: "my.1password.com" };
  try {
    execSync("op inject -i .env.tpl -o .env.local --force", {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: opEnv,
    });
    console.log(
      G(`✓ Wrote .env.local from .env.tpl (1Password, coal-stripes-dev vault${token ? ", via Keychain SA" : ", via personal session"})`),
    );
  } catch (e) {
    console.log(R("✗ op inject failed — no 1Password auth?"));
    console.log(
      D(
        `  One-time fix: store the coal-stripes-dev service-account token with\n` +
          `    security add-generic-password -U -a "$USER" -s ${KEYCHAIN_OP_SA} -w\n` +
          `  (paste the token at the prompt), then re-run: npx tsx env/setup.ts`,
      ),
    );
  }
} else {
  console.log(D(`.env.local already has ${API_KEY} — skipping op inject (use --force to refresh).`));
}

// 4. validation -------------------------------------------------------------
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
