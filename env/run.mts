#!/usr/bin/env npx tsx
// Byte-identical in every repo. The only per-project file is env/workspace.config.yaml.
import { runDevFromConfig } from "@simon/workspace-env";
await runDevFromConfig(import.meta.url);
