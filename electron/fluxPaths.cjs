// electron/fluxPaths.cjs — machine-level path resolution, shared by every
// surface: the Electron main process (require) and flux-core → CLI/MCP (ESM
// import of CJS; tsx and the esbuild bundles both handle it). It lives under
// electron/ (not flux-core/) because the packaged app ships only electron/** +
// dist/** and main.cjs is CommonJS, which cannot load TypeScript.
//
// HARD RULE (CLAUDE.md "Machine config paths"): machine-level config resolves
// ONLY to the lowercase app dir (~/.config/flux on Linux). The single allowed
// capital-F reference is legacyUserDataDir() — the migration SOURCE, nothing
// else. scripts/verify-fluxconfig.ts gates this repo-wide.
//
// No require("electron") in this file — it must run under plain Node.
"use strict";
const path = require("node:path");
const os = require("node:os");

/** Per-platform application-data root (the dir the app dir sits inside). */
function appDataRoot(platform) {
  const home = os.homedir();
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support");
    case "win32":
      return process.env.APPDATA || path.join(home, "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  }
}

/** The machine config dir — LOWERCASE "flux" on every platform, for every
 *  surface. main.cjs pins Electron to this via app.setPath("userData", ...)
 *  (packaged builds would otherwise derive the capital-F dir from
 *  productName), and flux-core/fluxlib.ts userDataDir() delegates here. The
 *  optional platform param lets the gate test assert all three branches. */
function userDataDir(platform = process.platform) {
  return path.join(appDataRoot(platform), "flux");
}

/** The legacy capital-F dir ("Flux") that packaged builds and old flux-core // flux-cap-ok
 *  used to resolve. Migration SOURCE only — never write here. On
 *  case-insensitive filesystems (macOS/Windows defaults) this is the SAME
 *  directory as userDataDir(); callers must dev+ino-compare before treating
 *  the two as distinct. */
function legacyUserDataDir(platform = process.platform) {
  return path.join(appDataRoot(platform), "Flux"); // flux-cap-ok
}

module.exports = {
  userDataDir,
  legacyUserDataDir,
};
