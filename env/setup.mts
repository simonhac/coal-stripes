#!/usr/bin/env npx tsx
// Byte-identical in every repo. The only per-project file is env/workspace.config.yaml.
import { runSetupFromConfig } from "@simon/workspace-env";
process.exit(await runSetupFromConfig(import.meta.url));
