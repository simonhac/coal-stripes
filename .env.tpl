# coal-stripes — committed environment template (dev).
#
# Secrets are 1Password references into the coal-stripes-dev vault — no values
# live in this file. Bootstrap a working .env.local with:
#
#   op inject -i .env.tpl -o .env.local
#
# (env/setup.ts does this automatically, using the service-account token from
# the macOS Keychain item op-sa-coal-stripes-dev, or your personal op session.)
# Prod secrets live in coal-stripes-prod and are set on the Worker with
# `wrangler secret put` — never via this file.
#
# NOTE: op inject parses secret references ANYWHERE in this file, including
# comments — never write one here unless its field exists in the vault.

# ── app secrets (references into the coal-stripes-dev vault's env item) ──────
OPENELECTRICITY_API_KEY="op://coal-stripes-dev/env/OPENELECTRICITY_API_KEY"

# ── non-secret config ─────────────────────────────────────────────────────────
# File logging is on locally, off in the deployed Worker (no filesystem).
ENABLE_FILE_LOGGING=true

# ── optional local knobs (uncomment as needed) ────────────────────────────────
# DEBUG=1
# DEBUG_OE=1
# There is no cron token any more: the refresher is the Worker's `scheduled`
# handler (wrangler.jsonc `triggers.crons`), invoked by Cloudflare itself over
# no HTTP route, so there is nothing to authorise. To run it by hand, use
# `wrangler dev` and its scheduled-trigger endpoint.
#
# POST /api/admin/purge, POST /api/admin/rebuild and the buttons for both on
# /diagnostics do still take a secret. The real one is prod-only (coal-stripes-prod vault) and is
# deliberately NOT written here — this file is committed to a public repo.
# CACHE_SECRET=local-dev-only
