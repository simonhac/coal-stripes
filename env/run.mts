#!/usr/bin/env -S npx --yes tsx
// Byte-identical in every repo. The only per-project file is env/workspace.config.yaml.
// `--yes`: run is concurrent with setup, so tsx may not be installed yet — avoid the npx prompt.
import { runDevFromConfig } from "@simon/workspace-env";
await runDevFromConfig(import.meta.url);
