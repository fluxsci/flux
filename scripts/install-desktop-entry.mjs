#!/usr/bin/env node
// Install a user-level desktop entry + hicolor icons for a Flux DEV CHECKOUT.
//
// Why this exists: on Linux we run native Wayland (`ozone-platform-hint=auto`,
// main.cjs — XWayland segfaults the GPU process on NVIDIA), and Wayland has NO
// protocol for a client to set its own window icon. `BrowserWindow.icon` is
// simply ignored there; the compositor instead matches the surface's `app_id`
// to an installed .desktop file and takes the icon from that. An unpackaged
// `electron .` run matches nothing, so GNOME draws its generic
// application-x-executable cog. The .deb/AppImage ship a real entry
// (electron-builder generates it from `linux.icon`) — only dev runs need this.
//
// X11 sessions don't need it (there `BrowserWindow.icon` sets _NET_WM_ICON and
// that's enough), but installing it is harmless and fixes the app grid too.
//
// Run: node scripts/install-desktop-entry.mjs        (or: npm run install:desktop-entry)
// Undo: rm ~/.local/share/applications/flux.desktop ~/.local/share/icons/hicolor/*/apps/flux.png
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.error(
    `install-desktop-entry: linux only (this is ${process.platform}).\n` +
      "  macOS dev runs get their Dock icon from app.dock.setIcon in electron/main.cjs;\n" +
      "  Windows dev runs get it from the BrowserWindow icon (build/icons/icon.ico).",
  );
  process.exit(1);
}

const root = join(fileURLToPath(import.meta.url), "..", "..");
const iconsDir = join(root, "build", "icons");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Electron's app name for an unpackaged run is package.json productName ?? name,
// and Chromium derives the Wayland app_id / X11 WM_CLASS from it. The entry only
// matches the window if StartupWMClass equals that app_id.
const appId = (pkg.productName || pkg.name).toLowerCase();

// The icon theme wants one file per size so the shell can pick per surface
// (dock, overview, alt-tab) instead of downscaling the 512. Sources are the
// already-generated plates from scripts/gen-app-icons.mjs.
const SIZES = {
  32: "32x32.png",
  64: "64x64.png",
  128: "128x128.png",
  256: "128x128@2x.png",
  512: "icon.png",
};

const missing = Object.values(SIZES).filter((f) => !existsSync(join(iconsDir, f)));
if (missing.length) {
  console.error(
    `install-desktop-entry: build/icons is missing ${missing.join(", ")} — ` +
      "run `node scripts/gen-app-icons.mjs` first.",
  );
  process.exit(1);
}

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
for (const [size, file] of Object.entries(SIZES)) {
  const dir = join(dataHome, "icons", "hicolor", `${size}x${size}`, "apps");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(iconsDir, file), join(dir, `${appId}.png`));
}

// Exec launches the BUILT app from this checkout (dist/index.html), the same
// thing `npm run electron:build` runs — NOT the vite dev server, which needs a
// separate `npm run dev`. Window-icon matching doesn't depend on Exec working,
// but a launcher that launches something is better than one that doesn't.
const require = createRequire(import.meta.url);
const electronBin = require("electron"); // resolves to this platform's binary path

const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=Flux
Comment=${pkg.description}
Exec=${electronBin} ${root}
Icon=${appId}
Terminal=false
Categories=Graphics;Publishing;
StartupWMClass=${appId}
StartupNotify=true
`;

const appsDir = join(dataHome, "applications");
mkdirSync(appsDir, { recursive: true });
const entryPath = join(appsDir, `${appId}.desktop`);
writeFileSync(entryPath, entry);

console.log(`installed ${entryPath}`);
console.log(`  icons   ${join(dataHome, "icons", "hicolor", "<size>", "apps", `${appId}.png`)}`);
console.log(`  matches windows whose app_id / WM_CLASS is "${appId}"`);
console.log("RESTART the app — a running window keeps the identity it was matched with.");
console.log(
  `NOTE: this user-level entry shadows a packaged /usr/share/applications/${appId}.desktop.\n` +
    `      Remove it before testing a real install: rm ${entryPath}`,
);
