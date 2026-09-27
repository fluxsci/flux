"use strict";
const path=require("node:path");
/** One independently owned machine-global watcher; dynamic roots are getter dependencies. */
function createGlobalLibraryWatcher({loadChokidar,fluxLibDir,captureDir,readPrefs,liveWindows,writeOrigin,notifyRenderer,TMP_WRITE_RE,onLibraryChange=()=>{},loadCaptureRules=()=>import("./captureRules.js")}) {
// W10 (LR-3): the machine-global FluxLib lives outside the project root, so classify
// its watched paths separately. We watch library.bib + .fluxlib/enrich.json + items/
// (NOT .fluxlib/locks/, whose 10s heartbeats would spam spurious revisions).
function fluxLibSubsystemFor(libRoot, abs) {
  const rel = path.relative(libRoot, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  if (rel === "library.bib" || rel === ".fluxlib/enrich.json" || rel === ".fluxlib/organize.json" || rel === "items" || rel.startsWith("items/")) {
    return "fluxlib";
  }
  // The drop-inbox: only landed PDFs count — sidecar notes and our own _unresolved/
  // filing must not re-trigger a scan (awaitWriteFinish already debounces mid-copy).
  if (rel.startsWith("pdfs_to_assign/")) {
    // `_unresolved/` is our own filing; `_captured_supplements/` is capture staging waiting on
    // a citekey — neither is a paper to identify, so neither may wake the assign scan.
    if (rel.includes("_unresolved/") || rel.includes("_captured_supplements/")) return null;
    return /\.pdf$/i.test(rel) ? "assign-inbox" : null;
  }
  return null;
}

// Web capture: the bookmarklet downloads `flux-<slug>.pdf` / `.fluxcap` into the browser's
// download folder. We watch ONLY for that prefix, so an ordinary download can never be
// mistaken for a capture and nothing of the user's is ever touched by accident.
// captureRules.js is ESM (the renderer imports it too), so this CommonJS file loads it by
// dynamic import — resolved once at watch setup, before any event can arrive.
//
// The event is a NOTIFICATION, not a trigger: the renderer only re-reads the waiting COUNT so
// the Library's Assign button stays live. Intake itself is user-initiated (startup or that
// button), so a capture landing here never rearranges the download folder on its own.
let captureRules = null;
function captureSubsystemFor(dir, abs) {
  if (!captureRules) return null;
  const rel = path.relative(dir, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null;
  // Two drop points: the extension writes into `<downloads>/flux/` (one click can produce an
  // article plus several supplements), the bookmarklet can only write to the root because
  // `<a download>` cannot name a directory. Nothing deeper is watched.
  const parts = rel.split("/");
  const name = parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === captureRules.CAPTURE_SUBDIR ? parts[1] : null;
  return name && captureRules.isCaptureFile(name) ? "capture" : null;
}

let globalWatcher = null, disposePending=()=>{},disposed=false;
// Serialize rebuilds: two windows opening projects concurrently must not
// interleave close/create on the shared watcher.
let globalWatcherChain = Promise.resolve();

async function closeCurrent() {
  const watcher=globalWatcher;globalWatcher=null;disposePending();disposePending=()=>{};
  if(watcher)await watcher.close().catch(()=>{});
}
async function closeGlobalWatcher() {
  globalWatcherChain=globalWatcherChain.catch(()=>{}).then(closeCurrent);
  await globalWatcherChain;
}

/** (Re)build the machine-global watcher. Rebuilt on every watch:setRoot so a
 *  freshly-connected Zotero bib / changed capture dir is picked up (the Library
 *  pane re-invokes watch:setRoot after connecting — behavior kept from the old
 *  single watcher). Once up it stays for the app's lifetime: a window going
 *  Home no longer drops FluxLib watching for the other windows. */
function rebuildGlobalWatcher() {
  globalWatcherChain = globalWatcherChain.catch(()=>{}).then(async () => {
    if(disposed)return;
    const ck = await loadChokidar();
    if (!ck || disposed) return;
    const libRoot = fluxLibDir();
    const capDir = captureDir();
    if (capDir && !captureRules) captureRules = await loadCaptureRules().catch(() => null);
    const zoteroPrefs = readPrefs().zotero;
    const zoteroBib =
      zoteroPrefs && typeof zoteroPrefs === "object" && typeof zoteroPrefs.bibPath === "string" && zoteroPrefs.bibPath
        ? path.resolve(zoteroPrefs.bibPath)
        : null;
    const targets = [
      // W10: the machine-global FluxLib (agent adds/enrich/fetch land here too).
      path.join(libRoot, "library.bib"),
      path.join(libRoot, ".fluxlib", "enrich.json"),
      path.join(libRoot, ".fluxlib", "organize.json"),
      path.join(libRoot, "items"),
      // The assign drop-inbox — a landed PDF triggers a scan in the open app.
      path.join(libRoot, "pdfs_to_assign"),
      ...(zoteroBib ? [zoteroBib] : []),
      // Web capture: the browser's download folder (top level only — see captureSubsystemFor).
      ...(capDir ? [capDir, path.join(capDir, "flux")] : []),
    ];
    await closeCurrent();
    if(disposed)return;
    const pending = new Map(); // subsystem -> latest changed path
    let timer = null;
    const flush = () => {
      timer = null;
      for (const [subsystem, change] of pending)
        for (const w of liveWindows()) if (!change.origins.has(w.webContents.id)) w.webContents.send("fs:changed", { subsystem, path: change.path, revision: Date.now() });
      pending.clear();
    };
    const watcher = ck.watch(targets, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      // Never surface in-flight atomic-write temp files (ours or flux-core's).
      ignored: (p) => TMP_WRITE_RE.test(p),
    });
    globalWatcher=watcher;
    disposePending=()=>{if(timer)clearTimeout(timer);timer=null;pending.clear();};
    watcher.on("all", (_evt, abs) => {
      if(globalWatcher!==watcher||disposed)return;
      const subsystem =
        fluxLibSubsystemFor(libRoot, abs) ??
        (zoteroBib && path.resolve(abs) === zoteroBib ? "zotero-bib" : null) ??
        (capDir ? captureSubsystemFor(capDir, abs) : null);
      if (!subsystem) return;
      // Every candidate reaches the resident index before renderer events are
      // coalesced. Own-window write suppression must not suppress freshness.
      if (subsystem === "fluxlib" && !/[\\/]\.fluxlib[\\/](enrich|organize)\.json$/.test(abs)) onLibraryChange(libRoot, abs);
      const origin = writeOrigin(abs);
      const existing = pending.get(subsystem);
      // Suppress only when every coalesced event belongs to this one window.
      const origins = existing ? new Set([...existing.origins].filter(id => id === origin)) : new Set(origin == null ? [] : [origin]);
      pending.set(subsystem, { path: abs, origins });
      if (!timer) timer = setTimeout(flush, 200);
    });
    watcher.on("error", (err) => {
      onLibraryChange(libRoot, null);
      notifyRenderer("error", "Library file-watch stopped", err && err.message);
    });
    onLibraryChange(libRoot, null); // rebuild may have missed events while closed
  });
  return globalWatcherChain;
}

  return {rebuild:rebuildGlobalWatcher,close:closeGlobalWatcher,dispose(){disposed=true;return closeGlobalWatcher();}};
}
module.exports={createGlobalLibraryWatcher};
