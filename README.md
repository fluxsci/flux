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

Build and run Flux from source. The **macOS** walkthrough below takes a clean
machine all the way to a running app — follow it top to bottom. **Linux** is the
same, minus the macOS-only notes (skip `xcode-select`; install Node 20 your way).

### Build & run locally on macOS

From a clean Mac to a running app — Apple Silicon (M-series) or Intel. A
locally-built app is **not** quarantined the way a downloaded one is, so it just
opens (no "damaged app" Gatekeeper dance).

**0 · Install prerequisites (one-time)**

Xcode Command Line Tools (`git`, `codesign`, compilers):

```sh
xcode-select --install
```

**Node.js 20 LTS** — important: Flux targets Node 20, and newer "Current" releases
(23, 24, 26, …) break Electron's binary install. Manage it with
[nvm](https://github.com/nvm-sh/nvm). If you don't have nvm yet, install it, then
**close and reopen Terminal**:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

**1 · Clone the repo**

```sh
git clone https://github.com/kortdriessen/flux.git
cd flux
```

**2 · Select Node 20** (the repo ships an `.nvmrc`, so this picks 20 automatically):

```sh
nvm install 20      # installs Node 20 if you don't have it
nvm use 20
node -v             # must print v20.x — NOT v23/24/26
```

**3 · Install dependencies + confirm Electron**

```sh
npm install
npx electron --version     # must print v33.x.x
```

`npm install` also downloads the Electron app binary; the `electron --version`
check confirms it landed. A harmless `EBADENGINE` warning during install is fine.

> **If `electron --version` errors** with _"Electron failed to install correctly"_,
> the binary download was skipped/blocked. Finish it and re-check:
> ```sh
> node node_modules/electron/install.js
> npx electron --version
> ```
> If it still fails, make sure `node -v` is **v20.x**, then
> `rm -rf node_modules && npm install`.

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
| `Electron failed to install correctly` | Make sure `node -v` is v20.x, then `node node_modules/electron/install.js` (or `rm -rf node_modules && npm install`) |
| `node -v` shows 23 / 24 / 26 | `nvm use 20` (run `nvm install 20` first if needed) — newer Node breaks Electron's install |
| `npm run electron:dev` shows only `[vite]` lines, no window | Make sure you're on a current clone (`git pull`); the dev server is pinned to `127.0.0.1` to fix a macOS hang |
| `codesign: command not found` | `xcode-select --install` |
| Built app won't open ("damaged" / unidentified) | `xattr -dr com.apple.quarantine release/mac-arm64/Flux.app`, or right-click → **Open** |
| Start completely clean | `rm -rf node_modules dist release && npm install` |

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
