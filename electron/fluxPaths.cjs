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
const agentsConfig = require("./agentsConfig.cjs");
const { FLUX_CONTEXT_FILES, FLUX_CONTEXT_HASH } = require("./fluxContextDocs.gen.cjs");

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

/** The machine Context layer: <FluxConfig>/Context/{UserContext,FluxContext}.
 *  UserContext = who the user is + their standing rules (user-owned; the old
 *  Guidelines folder migrates in). FluxContext = stock docs shipped with Flux
 *  (app-owned, re-synced on update). */
function contextPathSync(prefs = readPrefsRawSync()) {
  return path.join(resolveFluxConfigPathSync(prefs), "Context");
}
function userContextPathSync(prefs = readPrefsRawSync()) {
  return path.join(contextPathSync(prefs), "UserContext");
}
function fluxContextPathSync(prefs = readPrefsRawSync()) {
  return path.join(contextPathSync(prefs), "FluxContext");
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
//   (d) ensure Context/UserContext (Guidelines migrates in; WHO-AM-I + RULES
//       seeded once — user-owned afterwards)
//   (e) sync Context/FluxContext (stock docs, re-synced on content-hash change)
//   (f) seed agents.json (once — user-owned afterwards)
//   (g) record everything in <FluxConfig>/.fluxconfig.json (audit + fast-path)
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
    contextPath: contextPathSync(prefs),
    userContextPath: userContextPathSync(prefs),
    fluxContextPath: fluxContextPathSync(prefs),
    agentsConfigPath: agentsConfig.agentsConfigPathSync(resolveFluxConfigPathSync(prefs)),
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
      // realpath: a transitional symlink (old path -> <cfg>/FluxLib) is the
      // SAME tree, not a stranded second library — no warning for it.
      let distinct = true;
      try {
        distinct = fsSync.realpathSync(oldLib) !== fsSync.realpathSync(target);
      } catch {
        /* unreadable — treat as distinct and warn */
      }
      if (distinct) {
        const w = `both ${target} and ${oldLib} exist — leaving both untouched (nothing merged or deleted); resolve by hand`;
        console.error(`flux config: WARNING — ${w}`);
        events.push({ action: "stranded-fluxlib-warning", detail: w });
      }
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

// ---------------------------------------------------------------------------
// The machine Context layer (principal-agent scheme, 2026-07).
//   <cfg>/Context/UserContext/  — user-owned: WHO-AM-I.md + RULES.md (+ any
//     files the user adds). The pre-Context Guidelines/ folder migrates in.
//   <cfg>/Context/FluxContext/  — stock docs from fluxContextDocs.gen.cjs,
//     re-synced whenever their content hash changes ({{FLUX_CLI}}/{{FLUX_MCP}}
//     placeholders substituted with this install's resolved commands).
//   <cfg>/agents.json           — the agent roster (electron/agentsConfig.cjs).
// ---------------------------------------------------------------------------

async function ensureUserContext(cfg, events) {
  const uc = path.join(cfg, "Context", "UserContext");
  await fsp.mkdir(uc, { recursive: true });

  // Migrate the pre-Context Guidelines folder (if any) into UserContext.
  const g = path.join(cfg, "Guidelines");
  if (fsSync.existsSync(g)) {
    for (const name of await fsp.readdir(g)) {
      const from = path.join(g, name);
      if (name === "README.md") {
        try {
          if (fsSync.readFileSync(from, "utf8") === GUIDELINES_README) {
            await fsp.rm(from); // untouched stock seed — superseded by FluxContext/README.md
            continue;
          }
        } catch {
          /* unreadable — migrate as-is */
        }
      }
      let to = path.join(uc, name);
      if (fsSync.existsSync(to)) to = path.join(uc, "migrated-" + name);
      await fsp.rename(from, to);
    }
    if ((await fsp.readdir(g).catch(() => ["x"])).length === 0) await fsp.rmdir(g).catch(() => {});
    events.push({ action: "migrate-guidelines", detail: `${g} -> ${uc}` });
  }

  // The old seed name becomes the canonical RULES.md when none exists yet.
  const baseRules = path.join(uc, "base_rules.md");
  const rules = path.join(uc, "RULES.md");
  if (fsSync.existsSync(baseRules) && !fsSync.existsSync(rules)) {
    await fsp.rename(baseRules, rules);
    events.push({ action: "promote-base-rules", detail: `${baseRules} -> ${rules}` });
  }
  if (!fsSync.existsSync(rules)) {
    await fsp.writeFile(rules, GUIDELINES_BASE_RULES);
    events.push({ action: "seed-user-rules", detail: rules });
  }
  const who = path.join(uc, "WHO-AM-I.md");
  if (!fsSync.existsSync(who)) {
    await fsp.writeFile(who, WHO_AM_I_SEED);
    events.push({ action: "seed-who-am-i", detail: who });
  }
}

/** Resolve how THIS install runs the flux CLI/MCP (baked into the stock docs).
 *  `mcpPath` is the bare server script path for JSON config templates
 *  ({{FLUX_MCP_PATH}}); `cli`/`mcp` are full runnable command strings. */
function resolveOwnCliCommandsSync() {
  const appRoot = path.resolve(__dirname, "..");
  if (process.resourcesPath && __dirname.includes("app.asar")) {
    const base = path.join(process.resourcesPath, "app.asar.unpacked", "dist");
    const cli = path.join(base, "flux-cli.mjs");
    if (fsSync.existsSync(cli)) {
      const mcpPath = path.join(base, "flux-mcp.mjs");
      // One runnable string per platform: POSIX inline-env, or a cmd /s /c
      // wrapper on Windows (cmd strips the outer quotes; `set X=1&&` with no
      // space keeps the env value clean).
      const wrap = (p) =>
        process.platform === "win32"
          ? `cmd /d /s /c "set ELECTRON_RUN_AS_NODE=1&& "${process.execPath}" "${p}""`
          : `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${p}"`;
      return { cli: wrap(cli), mcp: wrap(mcpPath), mcpPath };
    }
  }
  const distCli = path.join(appRoot, "dist", "flux-cli.mjs");
  if (fsSync.existsSync(distCli)) {
    const mcpPath = path.join(appRoot, "dist", "flux-mcp.mjs");
    return { cli: `node "${distCli}"`, mcp: `node "${mcpPath}"`, mcpPath };
  }
  const srcCli = path.join(appRoot, "flux-cli.ts");
  if (fsSync.existsSync(srcCli)) {
    const mcpPath = path.join(appRoot, "flux-mcp.ts");
    return { cli: `npx tsx "${srcCli}"`, mcp: `npx tsx "${mcpPath}"`, mcpPath };
  }
  return { cli: "flux", mcp: "flux-mcp", mcpPath: "flux-mcp" }; // last resort: assume on PATH
}

/** The Lighttable sidecar dir ({{LIGHTTABLE_DIR}}): resolved when this install is
 *  a source checkout; a generic literal otherwise (packaged installs don't carry
 *  the sidecar — the stock doc tells agents to check existence first). */
function resolveLighttableDirSync() {
  const candidate = path.join(path.resolve(__dirname, ".."), "lighttable");
  return fsSync.existsSync(candidate) ? candidate : "<flux-repo>/lighttable";
}

/** The Flux source checkout ({{FLUX_REPO}}): resolved when this install IS one
 *  (marker: flux-cli.ts at the root); a generic literal otherwise. Stock docs
 *  use it for repo-only references (docs/, the sidecar) with a check-first note. */
function resolveRepoDirSync() {
  const candidate = path.resolve(__dirname, "..");
  return fsSync.existsSync(path.join(candidate, "flux-cli.ts")) ? candidate : "<flux-repo>";
}

// ---------------------------------------------------------------------------
// The `flux` PATH shim: ~/.local/bin/flux → this install's CLI, so `flux
// principal` etc. work by name. Managed-marker policy: we only create or
// rewrite a file that WE wrote (marker line) — a user's own `flux` binary is
// never touched, and replacing the shim with an unmarked file opts out.
// ---------------------------------------------------------------------------

const SHIM_MARKER = "# flux-cli shim (managed by Flux — replace with your own file to opt out)"; // flux-cap-ok

function cliShimPathSync() {
  // Same policy on every platform: only manage a shim if the user maintains a
  // ~/.local/bin (on Windows that means they PATH'd it themselves; there is no
  // conventional auto-on-PATH user bin dir to invent). Batch twin on win32.
  const name = process.platform === "win32" ? "flux.cmd" : "flux";
  return path.join(os.homedir(), ".local", "bin", name);
}

function cliShimUpToDateSync() {
  const binDir = path.dirname(cliShimPathSync());
  if (!fsSync.existsSync(binDir)) return true; // no ~/.local/bin — nothing to manage
  try {
    const cur = fsSync.readFileSync(cliShimPathSync(), "utf8");
    if (!cur.includes(SHIM_MARKER)) return true; // user's own file — leave alone
    return cur.includes(resolveOwnCliCommandsSync().cli);
  } catch {
    return false; // absent → install on the next full run
  }
}

async function installCliShim(events) {
  const shim = cliShimPathSync();
  const binDir = path.dirname(shim);
  if (!fsSync.existsSync(binDir)) return; // don't invent ~/.local/bin
  const { cli } = resolveOwnCliCommandsSync();
  if (cli === "flux") return; // last-resort resolution — nothing real to point at
  let cur = null;
  try {
    cur = fsSync.readFileSync(shim, "utf8");
  } catch {
    /* absent */
  }
  if (cur !== null && !cur.includes(SHIM_MARKER)) return; // user-owned — never clobber
  // The cmd body ends with `${cli} %*` so cliShimUpToDateSync's includes(cli)
  // staleness probe works for both shim flavors. CRLF is the batch convention.
  const body =
    process.platform === "win32"
      ? `@echo off\r\nrem ${SHIM_MARKER}\r\n${cli} %*\r\n`
      : `#!/bin/sh\n${SHIM_MARKER}\nexec ${cli} "$@"\n`;
  if (cur === body) return;
  await fsp.writeFile(shim, body, { mode: 0o755 });
  events.push({ action: "install-cli-shim", detail: shim });
}

function fluxContextStampPath(cfg) {
  return path.join(cfg, "Context", "FluxContext", ".version");
}

/** Cheap staleness probe for the ensureFluxConfig fast path. */
function fluxContextUpToDateSync(cfg) {
  try {
    if (JSON.parse(fsSync.readFileSync(fluxContextStampPath(cfg), "utf8")).hash !== FLUX_CONTEXT_HASH) return false;
  } catch {
    return false;
  }
  if (!fsSync.existsSync(agentsConfig.agentsConfigPathSync(cfg))) return false;
  if (fsSync.existsSync(path.join(cfg, "Guidelines"))) return false;
  if (!cliShimUpToDateSync()) return false;
  const uc = path.join(cfg, "Context", "UserContext");
  return fsSync.existsSync(path.join(uc, "RULES.md")) && fsSync.existsSync(path.join(uc, "WHO-AM-I.md"));
}

async function syncFluxContext(cfg, events) {
  const dir = path.join(cfg, "Context", "FluxContext");
  let cur = null;
  try {
    cur = JSON.parse(fsSync.readFileSync(fluxContextStampPath(cfg), "utf8"));
  } catch {
    /* first sync */
  }
  const upToDate = cur && cur.hash === FLUX_CONTEXT_HASH;
  // When the hash is current, only heal MISSING files — never rewrite existing
  // ones (a dev CLI and a packaged app resolve different {{FLUX_CLI}} strings;
  // rewriting on every engine switch would churn the folder).
  const names = Object.keys(FLUX_CONTEXT_FILES).filter(
    (n) => !upToDate || !fsSync.existsSync(path.join(dir, n)),
  );
  if (upToDate && names.length === 0) return;
  await fsp.mkdir(dir, { recursive: true });
  const cmds = resolveOwnCliCommandsSync();
  for (const name of names) {
    const out = FLUX_CONTEXT_FILES[name]
      .replaceAll("{{FLUX_CLI}}", cmds.cli)
      .replaceAll("{{FLUX_MCP}}", cmds.mcp)
      .replaceAll("{{FLUX_MCP_PATH}}", cmds.mcpPath)
      .replaceAll("{{LIGHTTABLE_DIR}}", resolveLighttableDirSync())
      .replaceAll("{{FLUX_REPO}}", resolveRepoDirSync());
    const p = path.join(dir, name);
    try {
      if (fsSync.readFileSync(p, "utf8") === out) continue;
    } catch {
      /* absent — write */
    }
    await fsp.writeFile(p, out);
  }
  await fsp.writeFile(
    fluxContextStampPath(cfg),
    JSON.stringify({ hash: FLUX_CONTEXT_HASH, cli: cmds.cli, synced: new Date().toISOString() }, null, 2) + "\n",
  );
  events.push({ action: "sync-fluxcontext", detail: `${dir} (${names.length} files, ${FLUX_CONTEXT_HASH})` });
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
    !legacyDirDistinct() &&
    fluxContextUpToDateSync(resolveFluxConfigPathSync(pre))
  ) {
    return configInfoSync(pre);
  }
  try {
    return await withConfigLock(async () => {
      const events = [];
      await mergeLegacyConfigDir(events);
      const cfg = await ensureConfigDirAndPointer(events);
      await migrateFluxLib(cfg, events);
      await ensureUserContext(cfg, events);
      await syncFluxContext(cfg, events);
      await installCliShim(events);
      if (agentsConfig.seedAgentsConfigSync(cfg)) {
        events.push({ action: "seed-agents-config", detail: agentsConfig.agentsConfigPathSync(cfg) });
      }
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
// moveFluxConfig — the Settings "Move…" action. The user picks the new PARENT
// directory; the folder itself is always named exactly "FluxConfig". Same-fs
// is a single rename; cross-device (EXDEV) falls back to copy → verify
// (recursive file count + byte total) → chmod keys.json 0600 → delete old —
// acceptable for an explicit user action, unlike auto-migration.
// ---------------------------------------------------------------------------

async function countTree(root) {
  let files = 0;
  let bytes = 0;
  const rec = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) {
        files++;
        bytes += (await fsp.stat(p)).size;
      }
    }
  };
  await rec(root);
  return { files, bytes };
}

async function moveFluxConfig(parentDir) {
  if (typeof parentDir !== "string" || !parentDir.trim()) return { error: "no destination chosen" };
  const prefs = readPrefsRawSync();
  const current = resolveFluxConfigPathSync(prefs);
  const target = path.join(path.resolve(parentDir), "FluxConfig");
  if (target === current) return { error: "that is already the FluxConfig location" };
  if ((target + path.sep).startsWith(current + path.sep)) return { error: "destination is inside the current FluxConfig" };
  if (!fsSync.existsSync(current)) return { error: `current FluxConfig is missing (${current})` };
  if (fsSync.existsSync(target)) {
    const entries = await fsp.readdir(target).catch(() => null);
    if (!entries) return { error: `cannot read ${target}` };
    if (entries.length > 0) return { error: `${target} already exists and is not empty` };
    await fsp.rmdir(target);
  }
  return withConfigLock(async () => {
    const events = [];
    try {
      await fsp.rename(current, target);
      events.push({ action: "move-fluxconfig", detail: `${current} -> ${target}` });
    } catch (e) {
      if (!e || e.code !== "EXDEV") return { error: (e && e.message) || String(e) };
      // Cross-device: copy, verify, then delete the original.
      const before = await countTree(current);
      await fsp.cp(current, target, { recursive: true });
      const after = await countTree(target);
      if (after.files !== before.files || after.bytes !== before.bytes) {
        await fsp.rm(target, { recursive: true, force: true });
        return { error: `copy verification failed (${after.files}/${before.files} files, ${after.bytes}/${before.bytes} bytes) — nothing was deleted` };
      }
      const keys = path.join(target, "FluxLib", "keys.json");
      if (fsSync.existsSync(keys)) await fsp.chmod(keys, 0o600); // cp does not reliably preserve mode
      await fsp.rm(current, { recursive: true, force: true });
      events.push({ action: "move-fluxconfig-exdev-copy", detail: `${current} -> ${target} (${after.files} files, ${after.bytes} bytes verified)` });
    }
    writePrefsAtomic({ ...readPrefsRawSync(), fluxConfigPath: target });
    await appendMarker(target, events);
    return { ok: true, path: target };
  });
}

// ---------------------------------------------------------------------------
// UserContext seed content. GUIDELINES_README survives only as the byte-compare
// reference for dropping the untouched stock README during Guidelines→
// UserContext migration; GUIDELINES_BASE_RULES doubles as the fresh-machine
// RULES.md seed. Embedded as strings (not repo asset files) so the packaged
// app and the esbuild CLI/MCP bundles carry them with zero packaging changes.
// ---------------------------------------------------------------------------

const WHO_AM_I_SEED = `# Who am I

<!-- Fill this out — every Flux agent reads it at session start. The more your
     agents know about you, the less you have to repeat yourself. Suggested
     content: your background and CV highlights, publications, research
     interests, technical strengths and weaknesses, what you are currently
     working on, and your tastes (writing style, figures, statistics). You can
     also add sibling files (or images) in this folder; agents read everything
     in UserContext/. -->

*(not filled out yet)*
`;

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
  contextPathSync,
  userContextPathSync,
  fluxContextPathSync,
  readPrefsRawSync,
  writePrefsAtomic,
  ensureFluxConfig,
  moveFluxConfig,
  configInfoSync,
  resolveOwnCliCommandsSync,
  GUIDELINES_README,
  GUIDELINES_BASE_RULES,
  WHO_AM_I_SEED,
};
