# Lighttable

**Lighttable is a standalone data-exploration sidecar that lives in the Flux repo but is NOT
part of Flux.**

It is a fast, minimal desktop app for exploratory viewing of **image sets**: open a parent
folder whose subfolders each hold one variant of a batch output (one image per item, aligned
by filename), see a grid of all images for one variant, **flip between variants instantly**
(the same cell changes — a flip-book), fullscreen any image, and compare one item across all
variants without leaving fullscreen. A digital light table / contact sheet for analysis
outputs — the triage step *before* you decide what to present.

## Boundary rules (the reason this README exists)

- Lighttable has its **own** `package.json`, `node_modules`, build, tests, dev port
  (**:1440** — Flux uses :1420), Electron app id (`lighttable` → `~/.config/lighttable`),
  protocol scheme (`ltfile://`), and docs (this file).
- **Zero code dependency in either direction.** Nothing here imports from Flux's `src/`,
  `flux-core/`, `electron/`, or `scripts/`; nothing in Flux imports from `lighttable/`.
- It shares only the repo home and a **copied** subset of Flexoki tokens
  (`src/tokens.css` — resynced by hand, deliberately not imported).
- Its tests are **not** wired into Flux's `scripts/verify-manifest.json` /
  `run-verifies.mjs`, and its deps are not in the root `package.json`.
- The Flux engineering guide does **not** govern Lighttable; this README is the sidecar's
  own source of truth. The directory is liftable into its own repository with no surgery.

## Run

```sh
cd lighttable
npm install
npm run electron:dev          # vite on :1440 + Electron
LT_OPEN=~/param_sweep npm run electron:dev   # dev + open a collection
npm start                     # build + run the built app
npm start -- ~/param_sweep    # …opening a collection (also: electron . <path>)
```

Open flows: the Open button / collection-name click (native picker), dropping a folder onto
the window, a CLI path argument (`LT_OPEN=<path>` in dev), and the Recent list.

## Concepts

**Collection** = the folder you open. **Set** = an immediate subfolder containing images
(loose images in the collection root form an "All" set). **Item** = one image, keyed by
filename without extension — the key aligns cells across sets, and a set missing an item
shows a placeholder so the flip-book never shifts. Supported formats:
png/jpg/jpeg/webp/gif/avif/bmp/svg; flat sets (no recursion); natural sort everywhere.

## Keyboard & mouse

| Key | Grid | Detail | Compare |
|---|---|---|---|
| `←→↑↓` | move selection (↑↓ = row) | ←→ item (skips missing), ↑↓ set | ←→ item |
| `Enter`/`Space` | open Detail | toggle fit / 1:1 (`Enter` only) | Detail (current set) |
| `Ctrl+Enter` | **Compare** — this item across ALL sets | — | — |
| `Esc` | clear search | back to grid / compare | back to grid |
| `1`–`9` | jump to set N | same | — |
| `Tab`/`Shift+Tab` | next / prev set | same | — |
| `[` `]` (or `-` `=`) | fewer / more columns | zoom out / in (`0` = fit) | — |
| scroll | — | pan ↑↓ (`Shift` = ↔) | — |
| `Ctrl+scroll` | — | zoom at cursor (pinch works) | — |
| hold `Space` + drag | — | pan | — |
| `/` | focus search | — | — |
| `c` | toggle captions | same | same |
| `Home`/`End` | first / last item | first / last present item | first / last item |
| `PageUp`/`PageDown` | scroll a page | — | — |

Mouse: click a cell = fullscreen it; **Ctrl+click** a cell = Compare (that item across all
sets, tiles packed as large as they fit, captioned by set name; click a tile to fullscreen
it, Esc steps back). In Detail: **Ctrl+scroll** zooms at the cursor (trackpad pinch too),
plain scroll pans ↑↓, **Shift+scroll** pans ↔, hold **Space** + drag = free pan; a click on
the backdrop beside a zoomed image returns to the grid. Top-left collection name: click =
**sister folders** (directories beside the current collection — switch with one click);
**Ctrl+click** = native folder picker. Grid H/V gaps are adjustable in the `⋯` menu
(persisted).

## Architecture (short)

Two processes plus a worker. Main (`electron/*.cjs`, plain CommonJS, no build step) owns fs
scanning, alignment, prefs, and a webp thumbnail cache (size buckets, atomic writes, LRU
sweep) in `userData/thumbs/`; the actual `@napi-rs/canvas` raster work runs in a
crash-isolated `utilityProcess` worker (it segfaults the main process under burst load —
never move it back). The renderer (Svelte 5 + Vite, `src/`) is UI only: a virtualized grid
(bounded DOM at any set size) whose cells adopt the images' **measured aspect ratio**
(median of decoded sizes, collection-global so the flip-book keeps its row heights) — wide
plots waste no vertical space. Images arrive via `ltfile://` — a path-validated privileged
protocol streaming from the collection root or the thumb cache. Sandbox + context isolation
+ strict CSP; the preload (`window.lt`) is the entire bridge.

Every direct-manipulation interaction targets **≤100 ms** (set switch, column change,
search, scroll, detail enter/leave) — measured by the gates, never masked with spinners.

## Test

```sh
npm test               # svelte-check + verify-pure + verify-node + verify-ui (:1440, system Chrome)
npm run test:electron  # opt-in: boots the REAL app (needs a display) and demands positive evidence
```

`verify-ui` drives the renderer in plain Chrome via a dev-only mock (`?mock=default`,
`?mock=big`) with client-side generated images; `window.__ltState` is the dev introspection
handle. Both are stripped from production builds.
