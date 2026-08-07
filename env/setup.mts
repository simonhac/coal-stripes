#!/usr/bin/env -S npx --yes tsx
// Byte-identical in every repo. The only per-project file is env/workspace.config.yaml.
// `--yes`: in a fresh worktree tsx isn't installed yet, so plain `npx tsx` would hang on an
// install prompt (see LiveOne#355). `.mts` forces ESM (works in non-"type":module repos).
import { runSetupFromConfig } from "@simon/workspace-env";
process.exit(await runSetupFromConfig(import.meta.url));
