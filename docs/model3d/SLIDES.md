# 3D slide data and export adapters

Deck assets retain GLB metadata. The live deck loader reads scene sidecars separately and never inserts GLB bytes into `assetData`. Figure-derived models stay referenced by ID; deck-to-Figure conversion uses verified native copies. Missing model files retain a placeholder on read and prevent a GUI save until restored or removed.

Portable payloads carry raw base64 GLBs in `models`, scene metadata in `modelManifests`, and Design-state poster references in `modelPosters`. Image assets contain only image data. Content-change target models are collected even when not directly placed. HTML and MP4 include the separate model runtime only when needed; its source hash participates in export-asset freshness and CSP generation.

PDF and PowerPoint use Design-state stills with furniture and report that 3D animation is exported as a still. Static payload gathering sets `modelData: "omit"` and prepares posters through a native or service-worker adapter. Ordinary deck saves never persist poster or GLB data URLs.

Slide presets are an explicit portable-byte boundary. Their GLBs are embedded when saving the preset and prepared through the native importer before insertion. A single deck mutation installs the resulting immutable asset metadata and slide; receipt adoption follows that mutation. Temporary preset bytes never become authoring asset data or save-journal entries.

Registered checks: `verify-model3d-deck-assets.ts` and `verify-model3d-slide-export.ts`, through `node scripts/run-verifies.mjs`. Playback and native capture qualification belong to the Stage 2 integration gates.
