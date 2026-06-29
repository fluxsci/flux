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

Requires **Node.js 20+**.

```sh
npm install
npm run electron:dev      # or: ./electron-dev.sh  — Vite dev server + Electron shell
```

Build a local package:

```sh
npm run dist:linux        # AppImage + .deb into ./release
npm run pack              # unpacked app (fast, for quick testing)
```

macOS builds are produced in CI (GitHub Actions) on tagged releases — push a
`vX.Y.Z` tag matching `package.json` `version` and the workflow in
`.github/workflows/release.yml` attaches the DMGs to a draft release.

## Related

- [**fluxplot**](https://github.com/kortdriessen/fluxplot) — the companion Python
  library that emits _semantic_ SVG plots (with `*.fluxplot.json` sidecars) that
  Flux imports as fully editable figures.

## License

[MIT](LICENSE) © Kort Driessen
