# coal-stripes — committed environment template (dev).
#
# Secrets are 1Password references into the coal-stripes-dev vault — no values
# live in this file. Bootstrap a working .env.local with:
#
#   op inject -i .env.tpl -o .env.local
#
# (env/setup.ts does this automatically, using the service-account token from
# the macOS Keychain item op-sa-coal-stripes-dev, or your personal op session.)
# Prod secrets live in coal-stripes-prod and are pushed to Vercel by the infra
# repo's sync tooling (config/coal-stripes.json) — never via this file.
#
# NOTE: op inject parses secret references ANYWHERE in this file, including
# comments — never write one here unless its field exists in the vault.

# ── app secrets (references into the coal-stripes-dev vault's env item) ──────
OPENELECTRICITY_API_KEY="op://coal-stripes-dev/env/OPENELECTRICITY_API_KEY"

# ── non-secret config ─────────────────────────────────────────────────────────
# File logging is on locally, off on Vercel (serverless).
ENABLE_FILE_LOGGING=true

# ── optional local knobs (uncomment as needed) ────────────────────────────────
# DEBUG=1
# DEBUG_OE=1
# To exercise /api/cron/warm-* locally: uncomment with ANY throwaway value and
# send the same value as `Authorization: Bearer …`. The real secret is
# prod-only (Vercel cron runs only in production; see coal-stripes-prod vault).
# CRON_SECRET=local-dev-only
