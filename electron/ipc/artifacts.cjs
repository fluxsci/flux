"use strict";
// The ARTIFACTS family: Paper's HTML pages. Read-only by construction: this family lists a
// folder, serves its files to a frame on the flux-artifact: origin, and watches it; it never
// writes into it. Two folders per project: <project>/artifacts (a convention, nothing to set
// up) and one linked folder the reader chose in Settings. The linked folder is MACHINE state
// (preferences.artifactDirs, keyed by project root), never project.json: it is an absolute
// path on this computer, and a project someone else wrote must not be able to point Flux at a
// folder of theirs.
const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { createArtifactServer, describeRoot, bodyStream, loadRules } = require("../artifactServe.cjs");

/** Folders in one root past which Flux lists it but does not watch it (inotify is finite). */
const WATCH_DIR_CAP = 1500;
const SERVED_CAP = 20000;

const linkedDirOf = (prefs, root) => {
  const dir = prefs && typeof prefs.artifactDirs === "object" && prefs.artifactDirs ? prefs.artifactDirs[root] : null;
  return typeof dir === "string" && path.isAbsolute(dir) ? path.resolve(dir) : null;
};
const networkDirs = (prefs) => new Set(Array.isArray(prefs?.artifactNetworkDirs) ? prefs.artifactNetworkDirs.filter((d) => typeof d === "string") : []);

function createArtifactsFamily({ app, protocol, shell, rootFor, sessionFor, readPrefs, writePrefs, loadChokidar }) {
  const server = createArtifactServer();
  const served = new Map(); // root id -> Set(real path) | "all": what pages of that root have loaded
  const watches = new Map(); // senderId -> { key, watcher, timer, paths, structure }
  const sameRoot = (e, requested) => {
    const root = rootFor(e);
    if (!root || typeof requested !== "string" || path.resolve(requested) !== root) throw new Error("This project is no longer open in this window");
    return root;
  };
  const noteServed = (id, file) => {
    let set = served.get(id);
    if (set === "all") return;
    if (!set) served.set(id, (set = new Set()));
    set.add(file);
    if (set.size > SERVED_CAP) served.set(id, "all");
  };

  app.whenReady().then(async () => {
    const { ARTIFACT_SCHEME } = await loadRules();
    protocol.handle(ARTIFACT_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const answer = await server.respond({ id: url.hostname, pathname: url.pathname, method: request.method, range: request.headers.get("range") });
        if (answer.file && answer.status < 300) noteServed(url.hostname, answer.file);
        const stream = bodyStream(answer.body);
        return new Response(stream ? Readable.toWeb(stream) : null, { status: answer.status, headers: answer.headers });
      } catch { return new Response("Unavailable artifact", { status: 404 }); }
    });
  });

  async function closeWatch(senderId) {
    const state = watches.get(senderId);
    watches.delete(senderId);
    if (state?.timer) clearTimeout(state.timer);
    if (state?.watcher) await state.watcher.close().catch(() => {});
  }

  async function watch(e, roots) {
    const senderId = e.sender.id;
    const targets = roots.filter((r) => r.id && r.watching).map((r) => ({ id: r.id, real: server.rootOf(r.id).real }));
    const key = targets.map((t) => t.real).sort().join("\n");
    if (watches.get(senderId)?.key === key) return;
    await closeWatch(senderId);
    if (!targets.length) return;
    const ck = await loadChokidar();
    if (!ck) return;
    const { skipArtifactDir, isHtmlName, ARTIFACT_LIMITS } = await loadRules();
    const state = { key, watcher: null, timer: null, paths: new Set(), structure: false };
    watches.set(senderId, state);
    const rootOfPath = (abs) => targets.find((t) => abs === t.real || abs.startsWith(t.real + path.sep));
    const flush = () => {
      state.timer = null;
      const session = sessionFor(e);
      if (watches.get(senderId) !== state || !session || session.win.isDestroyed()) return;
      session.win.webContents.send("artifacts:changed", { paths: [...state.paths].slice(0, 500), structure: state.structure });
      state.paths = new Set();
      state.structure = false;
    };
    const watcher = ck.watch(targets.map((t) => t.real), {
      ignoreInitial: true,
      depth: ARTIFACT_LIMITS.depth + 2,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p) => {
        const root = rootOfPath(p);
        if (!root || p === root.real) return false;
        return path.relative(root.real, p).split(path.sep).some(skipArtifactDir);
      },
    });
    watcher.on("all", (event, file) => {
      const abs = path.resolve(file), root = rootOfPath(abs);
      if (!root) return;
      // The rail changes when pages come and go (or a page's title may have); the open page
      // reloads only for a file some page of this root actually loaded. A build's log, its
      // scripts and data nobody asked for yet never reload anything.
      const structural = event !== "change" || isHtmlName(path.basename(abs));
      const loaded = served.get(root.id);
      const reload = loaded === "all" || !!loaded?.has(abs);
      if (!structural && !reload) return;
      if (structural) state.structure = true;
      if (reload) state.paths.add(abs);
      if (!state.timer) state.timer = setTimeout(flush, 300);
    });
    // A folder too large for the watch budget stays readable: the page has a reload button.
    watcher.on("error", () => { void closeWatch(senderId); });
    if (watches.get(senderId) !== state) { await watcher.close().catch(() => {}); return; }
    state.watcher = watcher;
  }

  async function listing(e, requestedRoot) {
    const root = sameRoot(e, requestedRoot);
    const { PROJECT_ARTIFACT_DIR, ARTIFACT_SCHEME } = await loadRules();
    const prefs = readPrefs();
    const linked = linkedDirOf(prefs, root);
    const net = networkDirs(prefs);
    const projectDir = path.join(root, PROJECT_ARTIFACT_DIR);
    const sources = [{ dir: projectDir, linked: false }];
    if (linked && linked !== projectDir) sources.push({ dir: linked, linked: true });
    const roots = [];
    for (const source of sources) {
      const described = await describeRoot(server, { ...source, projectRoot: root, urlBase: (id) => `${ARTIFACT_SCHEME}://${id}`, networkFor: (real) => net.has(real), watchDirCap: WATCH_DIR_CAP });
      if (described) roots.push(described);
    }
    await watch(e, roots).catch(() => {});
    return { roots, linkedDir: linked, projectDir };
  }

  /** A path a page of a registered root could show: for reveal / open in the browser. */
  function withinRoots(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) return null;
    let real;
    try { real = fs.realpathSync(file); } catch { return null; }
    for (const root of server.roots.values()) if (real === root.real || real.startsWith(root.real + path.sep)) return real;
    return null;
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("artifacts:list", (e, request) => listing(e, request?.root));
    ipcMain.handle("artifacts:setDir", async (e, request) => {
      const root = sameRoot(e, request?.root);
      const prefs = readPrefs();
      const dirs = { ...(prefs.artifactDirs && typeof prefs.artifactDirs === "object" ? prefs.artifactDirs : {}) };
      if (request.dir == null) delete dirs[root];
      else {
        if (typeof request.dir !== "string" || !path.isAbsolute(request.dir) || request.dir.includes("\0")) throw new Error("Choose a folder");
        const dir = path.resolve(request.dir);
        const stat = await fs.promises.stat(dir).catch(() => null);
        if (!stat?.isDirectory()) throw new Error("That folder does not exist");
        dirs[root] = dir;
      }
      writePrefs({ ...prefs, artifactDirs: dirs });
      return listing(e, root);
    });
    ipcMain.handle("artifacts:setNetwork", async (e, request) => {
      sameRoot(e, request?.root);
      const root = [...server.roots.values()].find((r) => r.real === request?.dir);
      if (!root) throw new Error("That artifact folder is not open");
      const prefs = readPrefs(), dirs = networkDirs(prefs);
      if (request.allow === true) dirs.add(root.real); else dirs.delete(root.real);
      writePrefs({ ...prefs, artifactNetworkDirs: [...dirs] });
      root.network = request.allow === true;
      return root.network;
    });
    ipcMain.handle("artifacts:reveal", (e, request) => {
      sameRoot(e, request?.root);
      const file = withinRoots(request?.path);
      if (!file) return false;
      shell.showItemInFolder(file);
      return true;
    });
    ipcMain.handle("artifacts:openInBrowser", async (e, request) => {
      sameRoot(e, request?.root);
      const file = withinRoots(request?.path);
      if (!file || !/\.html?$/i.test(file)) return false;
      return !(await shell.openPath(file));
    });
  }

  /**
   * An artifact frame goes only to artifact pages. A link to the web opens in the reader's
   * browser; anything else is refused. (The app's own frame-src policy says the same; this is
   * the half that turns a refusal into the right thing happening.)
   */
  function guardFrames(win) {
    win.webContents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) return;
      const current = details.frame?.url ?? "";
      if (!current.startsWith("flux-artifact:")) return; // not an artifact frame (the manuscript preview, a slide embed)
      if (/^(flux-artifact|about|blob|data):/i.test(details.url)) return;
      details.preventDefault();
      if (/^(https?|mailto):/i.test(details.url)) void shell.openExternal(details.url);
    });
  }

  return { registerHandlers, guardFrames, clear: closeWatch, closeAll: () => Promise.all([...watches.keys()].map(closeWatch)) };
}

module.exports = { createArtifactsFamily, linkedDirOf };
