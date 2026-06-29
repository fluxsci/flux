#!/usr/bin/env bash
# Launch Flux in the Electron (Chromium) shell with GPU knobs turned up.
# Runs from the script's own directory, so it works regardless of where the
# repo lives or what the folder is named.
cd "$(dirname "$0")"
exec npm run electron:dev
