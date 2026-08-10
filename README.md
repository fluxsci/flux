# Flux

A local-first desktop app for assembling scientific figures, papers, and slides —
join plots into figures, figures into papers, build slide decks, and manage a
full reference library (with a built-in PDF reader, full-text search, and
citations) — entirely offline and on your own machine.

![Flux](brand/flux_main_page.png)

> **Status:** early (v0.1), under active development.

## Documentation

The user docs live in [`docs/`](docs/) — start at [`docs/index.qmd`](docs/index.qmd)
(what Flux is, the five modes, a getting-started walkthrough, and full guides). They're
a Quarto site: run `quarto preview docs` for the nicely rendered, searchable version
(every full Flux setup has Quarto — see the [install guide](docs/installation.qmd)).

## Install

Download the latest build from the [**Releases**](https://github.com/fluxsci/flux/releases)
page, then follow the steps for your platform.

### macOS

**1 · Pick the right download.**

| Your Mac | Download |
| --- | --- |
| **Apple Silicon** — M1/M2/M3/M4 (most Macs from 2020 on) | the DMG with **`arm64`** in its name |
| **Intel** — older Macs | the other DMG (**`x64`**) |

Not sure which you have?  (Apple menu) → **About This Mac**: "Apple M…" means
Apple Silicon; "Intel" means the Intel build.

**2 · Install.** Open the downloaded `.dmg` and drag the **Flux** icon onto the
**Applications** folder shown in the window, then eject the disk image.

**3 · First launch — one-time Gatekeeper step.** Flux isn't yet signed with an
Apple Developer certificate, so macOS blocks it the first time (you may see
_"Flux is damaged and can't be opened"_ or _"unidentified developer"_). This is
expected for unsigned apps — clear the quarantine flag once. Open **Terminal**
(Applications → Utilities → Terminal) and run:

```sh
xattr -dr com.apple.quarantine /Applications/Flux.app
```

Then open Flux from Applications or Launchpad. You only need to do this once.

> **Prefer not to use Terminal?** Double-click Flux, dismiss the warning, then go
> to  (Apple menu) → **System Settings → Privacy & Security**, scroll to the
> message about Flux being blocked, and click **Open Anyway**.

### Linux

**Option A — AppImage (works on any distribution):**

1. Download `Flux-<version>.AppImage`.
2. Make it executable and run it:
   ```sh
   chmod +x Flux-*.AppImage
   ./Flux-*.AppImage
   ```

> On Ubuntu 22.04+/24.04 and other modern distros, AppImages need the FUSE 2
> runtime. If you get a `libfuse.so.2` / "error loading libfuse" message, install
> it once: `sudo apt install libfuse2`.

**Option B — Debian / Ubuntu (`.deb`):**

```sh
sudo apt install ./flux_<version>_amd64.deb
```

This installs Flux system-wide; launch it from your applications menu or by
running `flux` in a terminal. Update later by installing a newer `.deb` the same way.

### Windows

Not yet packaged — planned for a later release.

## Develop

Build and run Flux from source. The **macOS** walkthrough below takes a clean
machine all the way to a running app — follow it top to bottom. **Linux** is the
same, minus the macOS-only notes (skip `xcode-select`; install Node 22 your way).

### Build & run locally on macOS

From a clean Mac to a running app — Apple Silicon (M-series) or Intel. A
locally-built app is **not** quarantined the way a downloaded one is, so it just
opens (no "damaged app" Gatekeeper dance).

**0 · Install prerequisites (one-time)**

Xcode Command Line Tools (`git`, `codesign`, compilers):

```sh
xcode-select --install
```

**Node.js 22 LTS** — important: Flux's build toolchain (Electron 43 + electron-builder)
requires Node **≥ 22.12**, so use the Node 22 LTS line; older Node (20 and below) can't
package the app, and odd/non-LTS "Current" releases aren't tested. Manage it with
[nvm](https://github.com/nvm-sh/nvm). If you don't have nvm yet, install it, then
**close and reopen Terminal**:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

**1 · Clone the repo**

```sh
git clone https://github.com/fluxsci/flux.git
cd flux
```

**2 · Select Node 22** (the repo ships an `.nvmrc`, so this picks 22 automatically):

```sh
nvm install 22      # installs Node 22 if you don't have it
nvm use 22
node -v             # must print v22.x (≥ v22.12)
```

**3 · Install dependencies + confirm Electron**

```sh
npm ci                     # exact install from the committed lockfile
npx electron --version     # must print v43.x.x
```

`npm ci` also downloads the Electron app binary; the `electron --version`
check confirms it landed. A harmless `EBADENGINE` warning during install is fine.

> **`npm ci` vs `npm install`.** `npm ci` installs exactly what `package-lock.json` pins —
> the same tree CI, the release pipeline, and the [install guide](docs/installation.qmd)
> build from, and it never rewrites the lockfile. Reach for `npm install` only when you're
> deliberately adding or updating a dependency, since it re-resolves version ranges.

> **If `electron --version` errors** with _"Electron failed to install correctly"_,
> the binary download was skipped/blocked. Finish it and re-check:
> ```sh
> node node_modules/electron/install.js
> npx electron --version
> ```
> If it still fails, make sure `node -v` is **v22.x**, then
> `rm -rf node_modules && npm ci`.

**4 · Run it — live-reload dev loop**

```sh
npm run electron:dev
```

A native **Flux window** opens (Vite dev server on port 1420 + Electron); edits in
`src/` reload on save. `Ctrl+C` stops it.

> The `http://localhost:1420` page is just the bundler — **don't** open Flux in a
> browser there (the desktop APIs won't exist). Use the app window that opens.

**5 · (Optional) Build a standalone app**

```sh
# Fast — unpacked .app, no installer:
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack
open release/mac-arm64/Flux.app     # Intel Mac: release/mac-x64/Flux.app

# …or a full installer DMG (+ zip) in ./release:
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

`CSC_IDENTITY_AUTO_DISCOVERY=false` tells the packager not to look for an Apple
Developer certificate; the app is ad-hoc signed by `build/afterPack.cjs`, which is
all that's needed to launch locally. If macOS blocks a built app, right-click →
**Open**, or `xattr -dr com.apple.quarantine release/mac-arm64/Flux.app`.

#### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Electron failed to install correctly` | Make sure `node -v` is v22.x, then `node node_modules/electron/install.js` (or `rm -rf node_modules && npm ci`) |
| `EBADENGINE` / `node -v` is v20 or below | `nvm use 22` (run `nvm install 22` first if needed) — Electron 43's toolchain needs Node ≥ 22.12 |
| `npm run electron:dev` shows only `[vite]` lines, no window | Make sure you're on a current clone (`git pull`); the dev server is pinned to `127.0.0.1` to fix a macOS hang |
| `codesign: command not found` | `xcode-select --install` |
| Built app won't open ("damaged" / unidentified) | `xattr -dr com.apple.quarantine release/mac-arm64/Flux.app`, or right-click → **Open** |
| Start completely clean | `rm -rf node_modules dist release && npm ci` |

### Companion tools

The walkthrough above gets Flux running, but several capabilities live in **external tools
Flux detects at runtime** — so a fresh build starts out unable to compile a manuscript or
import a semantic plot. Per-platform instructions live in the
[install guide](docs/installation.qmd); this is just what breaks without each.

| Tool | Without it |
| --- | --- |
| **Quarto** | No manuscript compile (`flux compile`), no Word/PDF export, and the in-app **Docs** button has nothing to open |
| **TinyTeX** (`quarto install tinytex`) | `--to pdf` fails; `--to html` / `--to docx` still work |
| **`lineno` + `setspace`** | Journal-styled PDF (line numbers, double spacing) fails; ordinary PDF is unaffected |
| **fluxplot**, cloned to `~/fluxplot` | Plots import as opaque images instead of per-part editable figures — [the keystone](https://github.com/fluxsci/fluxplot) |
| **Lighttable** (`cd lighttable && npm ci && npm run build`) | The top-bar Lighttable button errors |

Only Lighttable is genuinely optional — the rest are load-bearing for normal use.

> **Setting up a Mac from scratch?**
> [`docs/for_agents/claude-install-flux-mac.md`](docs/for_agents/claude-install-flux-mac.md) is an executable
> runbook a Claude Code session follows end to end — bare clone to verified install,
> including everything in this table.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Dev server **+ Electron**, live reload — main dev loop |
| `npm run dev` | Vite dev server only (no Electron window) |
| `npm run build` | Full production build → `dist/`: renderer **+** slide-export assets **+** the agent CLI bundles (`flux-cli.mjs`, `flux-mcp.mjs`). Not interchangeable with plain `vite build` |
| `npm run pack` | Unpacked `Flux.app` → `release/` (fast) |
| `npm run dist:mac` / `dist:linux` | Installer (`.dmg`+`.zip` / `AppImage`+`.deb`) → `release/` |
| `npm run check` | Svelte / TypeScript type-check |
| `npm run flux -- <verb>` | The Flux CLI (drive a project from the shell — see **Agents & automation**) |
| `npm run flux:mcp -- <project>` | Start the Flux MCP server over stdio |

Keep your clone current with `git pull` (then `npm ci` if dependencies changed).
Clean rebuild if needed: `rm -rf node_modules dist release && npm ci`.

### Testing the app

Flux is verified with a headless **Live Visual Verification** harness: a Vite dev
server (`npm run dev`) driven by `puppeteer-core` against headless Chrome, which
screenshots before/after, reads the console for errors, and profiles hot paths for
60fps. The `?fixture=demo` URL loads an in-memory project and `window.__flux`
exposes the stores/editors for deterministic setup + assertions. The
`scripts/verify-*.mjs` (browser) and `scripts/verify-*.ts` (Node, via `tsx`) files
are runnable examples — e.g. `node scripts/verify-m11-m14.mjs`. Always run
`npm run check` **and** `npm run build` after a change.

### Releases (CI)

macOS + Linux installers are built in CI on a version tag — push a `vX.Y.Z` tag
matching `package.json` `version` and `.github/workflows/release.yml` attaches the
DMGs / AppImage / deb to a **draft** GitHub Release.

Before tagging, run the pre-release gate locally: `npm run release:check` does a
clean build, asserts the three `dist/` artifacts exist, runs the CLI + MCP bundle
handshakes, then packs the app and drives the **unpacked** CLI from an unrelated
directory (proving the packaged agent surface works outside the repo). Add
`--skip-pack` for a fast check that skips the minutes-long `electron-builder` step,
and set `RELEASE_TAG=vX.Y.Z` to also assert the tag matches `package.json`.

## Agents & automation

A Flux project is a plain folder, and **the file is the API**: a CLI, an MCP server,
and scripts/agents all operate by reading and writing the project files, while the
open app **watches the folder and live-reloads** — non-destructively, skipping its
own writes. Edit a caption from a script and it updates in the manuscript margin a
beat later.

- **Compose a whole figure** — `npm run flux -- compose-figure growth plots/*.svg --rows 2`
  takes N plots and assembles **one labeled, gridded, captioned multi-panel figure**
  (import → grid → auto-letter `a..j` → caption stub). Then `… render-figure growth --png out.png`
  to *see* it, and `… restyle growth control.line --stroke '#1b9e77'` to fix a part —
  the override survives the plot being regenerated.
- **CLI** — `npm run flux -- list`, plus `compose-figure`, `create-figure`, `arrange`,
  `auto-label`, `restyle`, `set-caption`, `add-reference`, `cite-doi`, `compile`,
  `validate`, `validate-plot`, `rerun-plot`, `new <dir>`. Full verb list: `npm run flux -- help`.
- **The reference library (FluxLib)** — a machine-global library the CLI drives too:
  `lib-add refs.bib --attach-files` bulk-imports BibTeX/RIS (with Zotero PDF attachments),
  `search-text "membrane potential"` scans the full text of every stored PDF, `fetch-pdfs`
  runs the open-access → library-proxy acquisition waterfall, `annotations --key K --md`
  exports a paper's highlights as Markdown, and `tag` / `set-status` / `collection` organize
  entries. `hydrate` backfills metadata from OpenAlex/CrossRef.
- **MCP server** — `npm run flux:mcp -- /path/to/project` exposes the same surface
  (`compose_figure`, `restyle_part`, `auto_label`, `get_figure_image` → a PNG so a vision
  agent can SEE its work, `search_fulltext`, `list_annotations`, `organize_paper`,
  `validate_project`, `validate_plot`, `compile`, …) to an MCP assistant.
- **Live bridge — act on what the human is doing.** While the app is open, the MCP tools
  `get_app_context`, `dispatch_command`, and `act_on_selection` let an agent read the live UI
  state (the current selection / drilled-in plot part / active figure) and act on it — over a
  **token-gated loopback** server — with every action being the same **undoable** edit a human
  makes. Closed app → the tools fall back to the file verbs.
- **Reproducible figures** — a plot can carry a *recipe* (its generating script +
  params). **Regenerate** it (CLI `rerun-plot`, or the Plot X-Ray button) and the
  drawing updates in place **while keeping your hand-tuned per-series styling**.
- **Safe coexistence** — every write is logged to `.meta/journal.ndjson` (who/what/when),
  and while you're mid-edit the app holds an advisory lock so an agent's file write **defers
  instead of clobbering** it.

The CLI/core (`flux-core/`) reuses the GUI's own figure-render and caption functions
through one pure ops core (`src/lib/ops.ts`), so there's one source of truth. Full reference:
**[`docs/reference/cli.qmd`](docs/reference/cli.qmd)** (every verb, with root resolution) and
**[`docs/agents/collaboration.qmd`](docs/agents/collaboration.qmd)** (the agent context and
collaboration system); `npm run flux -- help` is always current. Every scaffolded project also
ships an in-repo `AGENTS.md`.

## Related

- [**fluxplot**](https://github.com/fluxsci/fluxplot) — the companion Python
  library that emits _semantic_ SVG plots (with `*.fluxplot.json` sidecars) that
  Flux imports as fully editable figures.

## License

[MIT](LICENSE) © Kort Driessen
