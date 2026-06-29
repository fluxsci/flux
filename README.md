# Flux

A local-first desktop app for assembling scientific figures, papers, and slides —
join plots into figures, figures into papers, and build slide decks, entirely
offline and on your own machine.

![Flux](brand/flux_main_page.png)

> **Status:** early (v0.1), under active development.

## Install

Download the latest build from the [**Releases**](https://github.com/kortdriessen/flux/releases)
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

Requires **Node.js 20+** (and, on macOS, the Xcode Command Line Tools).

```sh
git clone https://github.com/kortdriessen/flux.git
cd flux
npm install
npm run electron:dev      # Vite dev server + Electron, with live reload
```

### Build & run locally on macOS

Step-by-step to clone and build Flux on a Mac — Apple Silicon (M-series) or Intel.
A locally-built app is **not** quarantined the way a downloaded one is, so it just
opens (no "damaged app" Gatekeeper dance).

**0 · One-time setup**

```sh
xcode-select --install        # git, codesign, compiler tooling
```

Use **Node.js 20 LTS** — the version Flux's tooling and CI target. Newer "Current"
releases (24, 26, …) can break the Electron binary install. Easiest with
[nvm](https://github.com/nvm-sh/nvm) (the repo ships an `.nvmrc`):

```sh
nvm install 20 && nvm use 20
node -v                       # → v20.x
```

**1 · Clone the repo**

```sh
git clone https://github.com/kortdriessen/flux.git
cd flux
```

**2 · Install dependencies**

```sh
npm install
```

(A `npm warn EBADENGINE … node >=22` message is harmless; Flux builds on Node 20.)

**3 · Develop with live reload** — the day-to-day loop:

```sh
npm run electron:dev
```

Starts the Vite dev server (port **1420**) and launches Electron pointed at it;
edits in `src/` reload on save. `Ctrl+C` to stop.

**4 · Build a standalone app**

```sh
# Fast — unpacked .app, no installer (best for quick testing):
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack

# Full installer — .dmg (+ .zip) into ./release:
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The `CSC_IDENTITY_AUTO_DISCOVERY=false` prefix tells the packager not to look for
an Apple Developer certificate; the app is instead *ad-hoc* signed by
`build/afterPack.cjs` — all that's needed for it to launch locally on Apple Silicon.
Without it, the build can fail trying to sign.

**5 · Run the built app**

```sh
open release/mac-arm64/Flux.app     # Intel Mac: release/mac-x64/Flux.app
```

If you ran `dist:mac`, the installer DMG is also in `release/`
(e.g. `Flux-0.1.0-arm64.dmg`). If macOS ever blocks the app, right-click → **Open**,
or clear the flag: `xattr -dr com.apple.quarantine release/mac-arm64/Flux.app`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Dev server **+ Electron**, live reload — main dev loop |
| `npm run dev` | Vite dev server only (no Electron window) |
| `npm run build` | Production web build → `dist/` |
| `npm run pack` | Unpacked `Flux.app` → `release/` (fast) |
| `npm run dist:mac` / `dist:linux` | Installer (`.dmg`+`.zip` / `AppImage`+`.deb`) → `release/` |
| `npm run check` | Svelte / TypeScript type-check |

Keep your clone current with `git pull` (then `npm install` if dependencies changed).
Clean rebuild if needed: `rm -rf node_modules dist release && npm install`.

### Releases (CI)

macOS + Linux installers are built in CI on a version tag — push a `vX.Y.Z` tag
matching `package.json` `version` and `.github/workflows/release.yml` attaches the
DMGs / AppImage / deb to a **draft** GitHub Release.

## Related

- [**fluxplot**](https://github.com/kortdriessen/fluxplot) — the companion Python
  library that emits _semantic_ SVG plots (with `*.fluxplot.json` sidecars) that
  Flux imports as fully editable figures.

## License

[MIT](LICENSE) © Kort Driessen
