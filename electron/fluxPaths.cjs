// electron/fluxPaths.cjs — machine-level path resolution + the FluxConfig
// engine, shared by every surface: the Electron main process (require) and
// flux-core → CLI/MCP (ESM import of CJS; tsx and the esbuild bundles both
// handle it). It lives under electron/ (not flux-core/) because the packaged
// app ships only electron/** + dist/** and main.cjs is CommonJS, which cannot
// load TypeScript.
//
// Two invariants (CLAUDE.md "Machine config paths"):
//   • Machine-level config resolves ONLY to the lowercase app dir
//     (~/.config/flux on Linux). The single allowed capital-F reference is
//     legacyUserDataDir() — the migration SOURCE, nothing else.
//   • All user-level state lives in ONE movable folder, FluxConfig (default
//     ~/FluxConfig, pointer: preferences.fluxConfigPath). FluxLib is DERIVED:
//     <FluxConfig>/FluxLib — never a separately persisted path.
// scripts/verify-fluxconfig.ts gates both, repo-wide.
//
// No require("electron") in this file — it must run under plain Node.
"use strict";
const path = require("node:path");
const os = require("node:os");
const fsSync = require("node:fs");
const fsp = require("node:fs/promises");

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

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

/** The legacy capital-F dir that packaged builds and old flux-core used to
 *  resolve. Migration SOURCE only — never write here. On case-insensitive
 *  filesystems (macOS/Windows defaults) this is the SAME directory as
 *  userDataDir(); callers must dev+ino-compare before treating the two as
 *  distinct. */
function legacyUserDataDir(platform = process.platform) {
  return path.join(appDataRoot(platform), "Flux"); // flux-cap-ok
}

/** First-run default for the user-facing FluxConfig folder. */
function defaultFluxConfigPath() {
  return path.join(os.homedir(), "FluxConfig");
}

/** FluxConfig: preferences pointer → default ~/FluxConfig. */
function resolveFluxConfigPathSync(prefs = readPrefsRawSync()) {
  const p = prefs && prefs.fluxConfigPath;
  return typeof p === "string" && p.trim() ? path.resolve(p) : defaultFluxConfigPath();
}

/** Guidelines folder — markdown/image conventions agents always read. */
function guidelinesPathSync(prefs = readPrefsRawSync()) {
  return path.join(resolveFluxConfigPathSync(prefs), "Guidelines");
}

/** The ONE FluxLib path decision. Derived from FluxConfig, with two legacy
 *  fallbacks that only apply pre-migration (or after an EXDEV-deferred move):
 *    1. <FluxConfig>/FluxLib exists          → that (normal, post-migration)
 *    2. prefs.fluxLibPath set + exists       → that (EXDEV escape hatch)
 *    3. ~/FluxLib exists                     → that (pre-migration default)
 *    4. otherwise                            → <FluxConfig>/FluxLib (fresh) */
function resolveFluxLibPathSync(prefs = readPrefsRawSync()) {
  const derived = path.join(resolveFluxConfigPathSync(prefs), "FluxLib");
  if (fsSync.existsSync(derived)) return derived;
  const legacyPref = prefs && typeof prefs.fluxLibPath === "string" && prefs.fluxLibPath.trim()
    ? path.resolve(prefs.fluxLibPath)
    : null;
  if (legacyPref && fsSync.existsSync(legacyPref)) return legacyPref;
  const legacyHome = path.join(os.homedir(), "FluxLib");
  if (fsSync.existsSync(legacyHome)) return legacyHome;
  return derived;
}

// ---------------------------------------------------------------------------
// preferences (sync, tiny — main.cjs keeps its own readPrefs; parity is
// guaranteed because both read the same file under the same resolver)
// ---------------------------------------------------------------------------

function prefsPath() {
  return path.join(userDataDir(), "preferences.json");
}

/** Raw prefs — `{}` when the file is missing/corrupt (callers that need the
 *  schemaVersion default use flux-core getPreferences / main.cjs readPrefs). */
function readPrefsRawSync() {
  try {
    return JSON.parse(fsSync.readFileSync(prefsPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

/** Atomic prefs write (tmp + rename), preserving/defaulting schemaVersion.
 *  Like flux-core setPreferences, `undefined` values drop their key. */
function writePrefsAtomic(next) {
  const out = { ...next, schemaVersion: (next && next.schemaVersion) || "0.1.0" };
  fsSync.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  const tmp = prefsPath() + ".tmp-" + process.pid;
  fsSync.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  fsSync.renameSync(tmp, prefsPath());
}

// ---------------------------------------------------------------------------
// config lock — serializes first-run migration across concurrent CLI + app
// launches. Deliberate small CJS twin of flux-core/locks.ts
// withHeartbeatLockAt (30s TTL, 10s restamp; that module is TypeScript and
// unreachable from main.cjs — keep the two in sync). Lives in userData, not
// FluxLib, because FluxLib itself is what migration moves.
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 30_000;

async function withConfigLock(fn) {
  const dir = path.join(userDataDir(), "locks");
  const p = path.join(dir, "config.json");
  await fsp.mkdir(dir, { recursive: true });
  const payload = () => JSON.stringify({ client: "fluxconfig", pid: process.pid, ts: new Date().toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fsp.open(p, "wx"); // atomic exclusive create
      try {
        await fh.writeFile(payload(), "utf8");
      } finally {
        await fh.close();
      }
      break; // acquired
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
    }
    let info = null;
    try {
      info = JSON.parse(await fsp.readFile(p, "utf8"));
    } catch {
      /* unreadable → stale */
    }
    const fresh = info && info.ts && Date.now() - Date.parse(info.ts) < LOCK_TTL_MS;
    if (!fresh) {
      await fsp.rm(p, { force: true }).catch(() => {});
      continue; // cleared a stale lock — retry is free
    }
    if (attempt >= 40) throw new Error('deferred: "config" is locked (held by another flux process). Re-run in a moment.');
    await new Promise((r) => setTimeout(r, 250));
  }
  const restamp = setInterval(() => {
    fsp
      .readFile(p, "utf8")
      .then((t) => {
        const i = JSON.parse(t);
        if (i && i.pid === process.pid) return fsp.writeFile(p, payload());
      })
      .catch(() => {});
  }, 10_000);
  if (restamp.unref) restamp.unref();
  try {
    return await fn();
  } finally {
    clearInterval(restamp);
    try {
      const i = JSON.parse(await fsp.readFile(p, "utf8"));
      if (!i || i.pid === process.pid) await fsp.rm(p, { force: true });
    } catch {
      await fsp.rm(p, { force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// ensureFluxConfig — the one-time (then no-op) machine init/migration:
//   (a) merge the legacy capital-F config dir into the lowercase one
//   (b) create FluxConfig + persist the pointer
//   (c) move FluxLib inside FluxConfig (same-fs rename; EXDEV defers)
//   (d) seed Guidelines/ (once — user-owned afterwards)
//   (e) record everything in <FluxConfig>/.fluxconfig.json (audit + fast-path)
// Idempotent: every step is existence-guarded; later runs hit a statSync-only
// fast path. Failures never throw past this function's contract lightly — a
// deferred/failed move leaves the resolver fallbacks working and is recorded.
// ---------------------------------------------------------------------------

function markerPath(cfg) {
  return path.join(cfg, ".fluxconfig.json");
}

/** True when the legacy capital-F dir exists as a DISTINCT directory (i.e.
 *  there is merge work to do — same dev+ino means a case-insensitive fs). */
function legacyDirDistinct() {
  let ls;
  try {
    ls = fsSync.statSync(legacyUserDataDir());
  } catch {
    return false; // absent — nothing to merge
  }
  try {
    const us = fsSync.statSync(userDataDir());
    return !(us.dev === ls.dev && us.ino === ls.ino);
  } catch {
    return true; // legacy exists, lowercase doesn't — definitely distinct
  }
}

function configInfoSync(prefs = readPrefsRawSync()) {
  return {
    fluxConfigPath: resolveFluxConfigPathSync(prefs),
    fluxLibPath: resolveFluxLibPathSync(prefs),
    guidelinesPath: guidelinesPathSync(prefs),
    userDataDir: userDataDir(),
  };
}

async function mergeLegacyConfigDir(events) {
  if (!legacyDirDistinct()) return;
  const legacy = legacyUserDataDir();
  const lower = userDataDir();
  await fsp.mkdir(lower, { recursive: true });
  // preferences.json — shallow merge, lowercase values win per key.
  const lp = path.join(legacy, "preferences.json");
  if (fsSync.existsSync(lp)) {
    let old = {};
    try {
      old = JSON.parse(fsSync.readFileSync(lp, "utf8")) || {};
    } catch {
      /* corrupt legacy prefs — nothing to merge */
    }
    writePrefsAtomic({ ...old, ...readPrefsRawSync() });
    events.push({ action: "merge-preferences", detail: `merged ${lp} (lowercase values win)` });
  }
  // textstyles.json — lowercase wins when both exist.
  const lt = path.join(legacy, "textstyles.json");
  const ut = path.join(lower, "textstyles.json");
  if (fsSync.existsSync(lt) && !fsSync.existsSync(ut)) {
    await fsp.copyFile(lt, ut);
    events.push({ action: "move-textstyles", detail: `${lt} -> ${ut}` });
  }
  // The pre-FluxLib seed some ancient installs kept under references/.
  const lb = path.join(legacy, "references", "library.bib");
  const ub = path.join(lower, "references", "library.bib");
  if (fsSync.existsSync(lb) && !fsSync.existsSync(ub)) {
    await fsp.mkdir(path.dirname(ub), { recursive: true });
    await fsp.copyFile(lb, ub);
    events.push({ action: "move-legacy-bib", detail: `${lb} -> ${ub}` });
  }
  // Anything else in the legacy dir is Chromium session state — discarded by
  // owner decision (2026-07-09); the two files above are the only config.
  await fsp.rm(legacy, { recursive: true, force: true });
  events.push({ action: "remove-legacy-config-dir", detail: legacy });
}

async function ensureConfigDirAndPointer(events) {
  const prefs = readPrefsRawSync();
  const cfg = resolveFluxConfigPathSync(prefs);
  if (!fsSync.existsSync(cfg)) {
    await fsp.mkdir(cfg, { recursive: true });
    events.push({ action: "create-fluxconfig", detail: cfg });
  }
  if (typeof prefs.fluxConfigPath !== "string" || !prefs.fluxConfigPath.trim()) {
    writePrefsAtomic({ ...prefs, fluxConfigPath: cfg });
    events.push({ action: "set-fluxConfigPath-pref", detail: cfg });
  }
  return cfg;
}

async function migrateFluxLib(cfg, events) {
  const prefs = readPrefsRawSync();
  const target = path.join(cfg, "FluxLib");
  const oldLib =
    typeof prefs.fluxLibPath === "string" && prefs.fluxLibPath.trim()
      ? path.resolve(prefs.fluxLibPath)
      : path.join(os.homedir(), "FluxLib");
  const dropKey = () => {
    const p = readPrefsRawSync();
    if ("fluxLibPath" in p) {
      delete p.fluxLibPath;
      writePrefsAtomic(p);
      events.push({ action: "drop-fluxLibPath-pref", detail: "FluxLib is derived from FluxConfig now" });
    }
  };
  if (fsSync.existsSync(target)) {
    if (oldLib !== target && fsSync.existsSync(oldLib)) {
      const w = `both ${target} and ${oldLib} exist — leaving both untouched (nothing merged or deleted); resolve by hand`;
      console.error(`flux config: WARNING — ${w}`);
      events.push({ action: "stranded-fluxlib-warning", detail: w });
    }
    dropKey();
    return;
  }
  if (oldLib === target || !fsSync.existsSync(oldLib)) return; // fresh machine — lazy ensureFluxLib creates at the derived path
  try {
    await fsp.rename(oldLib, target); // same-fs: O(1) for any size, modes/mtimes preserved
    events.push({ action: "move-fluxlib", detail: `${oldLib} -> ${target}` });
    dropKey();
  } catch (e) {
    if (e && e.code === "EXDEV") {
      const w =
        `${oldLib} is on a different filesystem than ${cfg} — left in place (still fully working). ` +
        `Move it from Flux Settings ("Move…"), or point FluxConfig at that filesystem.`;
      console.error(`flux config: ${w}`);
      events.push({ action: "fluxlib-move-deferred-exdev", detail: w });
    } else {
      const w = `could not move ${oldLib} -> ${target}: ${(e && e.message) || e}. Left in place (still fully working).`;
      console.error(`flux config: ${w}`);
      events.push({ action: "fluxlib-move-failed", detail: w });
    }
  }
}

async function seedGuidelines(cfg, events) {
  const g = path.join(cfg, "Guidelines");
  if (fsSync.existsSync(g)) return; // user-owned — never re-seed, even if emptied
  await fsp.mkdir(g, { recursive: true });
  await fsp.writeFile(path.join(g, "README.md"), GUIDELINES_README);
  await fsp.writeFile(path.join(g, "base_rules.md"), GUIDELINES_BASE_RULES);
  events.push({ action: "seed-guidelines", detail: `${g} (README.md, base_rules.md)` });
}

async function appendMarker(cfg, events) {
  const p = markerPath(cfg);
  let cur = null;
  try {
    cur = JSON.parse(fsSync.readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  const now = new Date().toISOString();
  const next =
    cur && Array.isArray(cur.events) ? cur : { schemaVersion: "0.1.0", created: now, events: [] };
  for (const ev of events) next.events.push({ ts: now, ...ev });
  const tmp = p + ".tmp-" + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
  await fsp.rename(tmp, p);
}

async function ensureFluxConfig() {
  // Escape hatch for test harnesses: verify scripts spawn the REAL CLI/MCP,
  // and migration against the developer's real HOME mid-test-run would move
  // their actual library. run-verifies.mjs sets this for every child; the
  // fluxconfig gate test clears it inside its scratch-HOME simulations.
  if (process.env.FLUX_NO_MIGRATE === "1") return configInfoSync();
  // Fast path (statSync-only) — the every-later-run case.
  const pre = readPrefsRawSync();
  if (
    fsSync.existsSync(markerPath(resolveFluxConfigPathSync(pre))) &&
    typeof pre.fluxConfigPath === "string" &&
    !("fluxLibPath" in pre) &&
    !legacyDirDistinct()
  ) {
    return configInfoSync(pre);
  }
  try {
    return await withConfigLock(async () => {
      const events = [];
      await mergeLegacyConfigDir(events);
      const cfg = await ensureConfigDirAndPointer(events);
      await migrateFluxLib(cfg, events);
      await seedGuidelines(cfg, events);
      await appendMarker(cfg, events);
      return { ...configInfoSync(), events };
    });
  } catch (e) {
    if (String((e && e.message) || "").startsWith("deferred:")) {
      // Another flux process is mid-migration — trust it and resolve best-effort.
      return configInfoSync();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Guidelines seed content. These constants are only the FIRST-RUN seed — the
// live copy is the user's <FluxConfig>/Guidelines/, which they own outright.
// Embedded as strings (not a repo asset file) so the packaged app and the
// esbuild CLI/MCP bundles carry them with zero packaging changes.
// ---------------------------------------------------------------------------

const GUIDELINES_README = `# Flux Guidelines

Everything in this folder is a standing convention for Flux work on this
machine. Flux agents read EVERY file here (markdown and images) at the start
of every session and follow it. Add, edit, or remove files freely — this
folder is yours; Flux seeds it once and never rewrites it.
`;

const GUIDELINES_BASE_RULES = `# Base conventions to follow when working in flux projects:
- Any atomic write-up or 'paper' should correspond to a single .qmd document, and all figures should be made on a single canvas - i.e. you should use a single canvas per .qmd document. If a new subproject or write up is distinct enough to warrant its own .qmd document, then all figures for that subproject should be made on a single canvas. This is not a 100% hard rule, but a general practice to follow to keep things organized.
- Always use panel labels (a, b, c, etc.) when creating multi-plot figures (very common) and refernce the specific and relevant panel(s) when writing.
- Always keep figure captions up to date and in the style of major scientific journals (e.g. Nature, Science, Cell, etc.).
- Add references to project's FluxLib when needed.
- Always review figures visually to confirm they are as expected and do not contain any errors or artifacts.

(New additions)
---
- When writing up manuscripts or technical reports, do NOT have a figures section at the end of the document, instead, figures should be embedded one single time, wherever they are the most relevant in the text (for a scientific manuscript, this is almost always in the relevant section of the results).

- Always use the default saved font styles where appropriate - e.g. Panel Labels should use the 'Panel Label' style
`;

module.exports = {
  userDataDir,
  legacyUserDataDir,
  defaultFluxConfigPath,
  resolveFluxConfigPathSync,
  resolveFluxLibPathSync,
  guidelinesPathSync,
  readPrefsRawSync,
  writePrefsAtomic,
  ensureFluxConfig,
  configInfoSync,
  GUIDELINES_README,
  GUIDELINES_BASE_RULES,
};
