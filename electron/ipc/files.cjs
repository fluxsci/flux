"use strict";
// WS-9.4b: the FILES handler family — write-safety core (atomic writes +
// self-write TTL for the watcher), the fsGuard path allowlist, dialog
// approvals, and the fs:* / dlg:* IPC handlers — extracted verbatim from
// main.cjs (composition root). Channel names and behavior unchanged; the
// project-lifecycle roots (currentRoot/pendingRoot) stay OWNED by main and
// arrive here as getter/setter deps, so the later project-family split
// doesn't have to move them again.

const path = require("node:path");
const fs = require("node:fs");

// W2 (V1 review): durable renderer writes — every fs:write* lands via
// write-tmp + fsync + rename, so a crash/power-loss can never truncate a
// project file and no reader (agent CLI, watcher) sees a half-written file.
// The dot-prefixed `.name.tmp-<pid>-<seq>` pattern is shared with
// flux-core/fsx.ts and ignored by the project watcher.
const TMP_WRITE_RE = /(^|[/\\])\.[^/\\]*\.tmp-\d+-\d+$/;

/**
 * Build the file core. deps:
 *   app       — Electron app (userData/temp paths)
 *   dialog    — Electron dialog (dlg:* handlers)
 *   roots     — () => extra allowed root dirs (main supplies currentRoot,
 *               pendingRoot, FluxConfig, FluxLib — the lifecycle state it owns)
 *   setPendingRoot — (abs|null) => void   (fs:beginOpen writes main's slot)
 */
function createFileCore({ app, dialog, roots, setPendingRoot }) {
  const recentWrites = new Map(); // absPath -> expiry (ms)
  function noteWrite(p) {
    recentWrites.set(path.resolve(p), Date.now() + 1500);
  }

  let atomicSeq = 0;
  async function atomicWriteMain(p, data) {
    const dir = path.dirname(p);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(p)}.tmp-${process.pid}-${++atomicSeq}`);
    noteWrite(tmp);
    const fh = await fs.promises.open(tmp, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.promises.rename(tmp, p);
      // SHL-10: refresh the self-write TTL at COMPLETION. The watcher's
      // awaitWriteFinish only fires ≥250ms after the last write, so a large/slow
      // write (e.g. the ~12MB enrich.json) could otherwise outlive the TTL set at
      // write-start and echo back as a spurious "external change".
      noteWrite(p);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  function isSelfWrite(p) {
    const ab = path.resolve(p);
    const exp = recentWrites.get(ab);
    if (exp && exp > Date.now()) return true;
    if (exp) recentWrites.delete(ab);
    return false;
  }

  // M9: path-validation for the fs:* handlers (defense-in-depth — matters more now
  // that F1's agent/watch surface widens the attack area, and guards against a
  // malicious project.json with a traversal path). When a project is open we only
  // touch paths under (a) the project root, (b) the app's own dirs, or (c) a
  // directory the user explicitly reached through a file dialog (imports/exports).
  const approvedDirs = new Set();
  function approveDir(p) {
    if (p) approvedDirs.add(path.resolve(path.dirname(p)));
  }
  function underDir(ab, dir) {
    return ab === dir || ab.startsWith(dir + path.sep);
  }
  function fsGuard(p) {
    // WS-9.3: deny-by-default. The old currentRoot-null early-return allowed
    // EVERYTHING in the launch→open window (and on Home) — the app dirs +
    // FluxLib (via roots()) are all Home actually needs.
    const ab = path.resolve(p);
    // W12 (SHL-6): $HOME is deliberately NOT a root — allowing the entire user home
    // made the guard nearly a no-op. Imports/exports outside the project still work
    // because a file dialog `approveDir`s the chosen directory.
    const all = [app.getPath("userData"), app.getPath("temp"), ...roots(), ...approvedDirs].filter(Boolean);
    if (all.some((r) => underDir(ab, path.resolve(r)))) return;
    throw new Error(`refused path outside project/app roots: ${p}`);
  }

  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
    ipc.handle("dlg:open", async (_e, opts) => {
      const res = await dialog.showOpenDialog({
        properties: opts.directory
          ? ["openDirectory"]
          : opts.multiple
            ? ["openFile", "multiSelections"]
            : ["openFile"],
        filters: opts.filters,
        title: opts.title,
      });
      if (res.canceled) return null;
      // M9: the user reached this dir on purpose — allow reading it + its siblings
      // (the plot importer reads manifest/recipe next to a chosen .svg).
      res.filePaths.forEach(approveDir);
      return opts.multiple ? res.filePaths : res.filePaths[0];
    });

    ipc.handle("dlg:save", async (_e, opts) => {
      const res = await dialog.showSaveDialog({
        defaultPath: opts.defaultPath,
        filters: opts.filters,
        title: opts.title,
      });
      if (res.canceled) return null;
      approveDir(res.filePath); // M9: allow writing the chosen export + sidecars
      return res.filePath;
    });

    ipc.handle("fs:readFile", async (_e, p) => {
      fsGuard(p);
      const buf = await fs.promises.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });
    ipc.handle("fs:writeFile", async (_e, p, data) => {
      fsGuard(p);
      noteWrite(p);
      await atomicWriteMain(p, Buffer.from(data));
    });
    ipc.handle("fs:readText", async (_e, p) => {
      fsGuard(p);
      return fs.promises.readFile(p, "utf8");
    });
    ipc.handle("fs:writeText", async (_e, p, text) => {
      fsGuard(p);
      noteWrite(p);
      await atomicWriteMain(p, Buffer.from(String(text), "utf8"));
    });
    ipc.handle("fs:mkdir", async (_e, p) => {
      fsGuard(p);
      await fs.promises.mkdir(p, { recursive: true });
    });
    // WS-5.3: atomicWriteMain fsyncs the FILE, but on Linux/mac a crash right
    // after the rename can still lose the DIRECTORY entry — callers fsync the
    // parent dir once per write batch. Best-effort; no-op on win32 (no dir fsync).
    ipc.handle("fs:fsyncDir", async (_e, p) => {
      fsGuard(p);
      if (process.platform === "win32") return;
      let fh;
      try {
        fh = await fs.promises.open(p, "r");
        await fh.sync();
      } catch {
        /* best-effort durability */
      } finally {
        await fh?.close().catch(() => {});
      }
    });
    ipc.handle("fs:exists", async (_e, p) => {
      fsGuard(p); // W12 (SHL-6): was unguarded — an existence-probe of any path
      try {
        await fs.promises.access(p);
        return true;
      } catch (err) {
        // SHL-18: only ENOENT means "not there". EACCES/EPERM etc. mean the path EXISTS but isn't
        // accessible — reporting that as absent would let a caller wrongly treat it as free to create.
        return !!(err && err.code && err.code !== "ENOENT");
      }
    });
    ipc.handle("fs:stat", async (_e, p) => {
      fsGuard(p);
      try {
        const st = await fs.promises.stat(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null; // absent (or blocked) — callers treat null as "no cacheable identity"
      }
    });
    ipc.handle("fs:readdir", async (_e, p) => {
      fsGuard(p); // W12 (SHL-6): was unguarded — a directory-listing of any path
      try {
        const es = await fs.promises.readdir(p, { withFileTypes: true });
        return es.map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return [];
      }
    });
    // Delete a file (used to clear a paper's fetch-failure record on a later success). Guarded
    // to the same project/app roots as every other write; a missing file is a no-op success.
    ipc.handle("fs:remove", async (_e, p) => {
      fsGuard(p);
      try {
        await fs.promises.rm(p, { force: true });
      } catch {
        /* already gone / unremovable — treat as removed */
      }
    });

    ipc.handle("fs:beginOpen", async (_e, root) => {
      // WS-9.3: pre-register the project the renderer is about to load, so the
      // load's fs:* reads pass the deny-by-default guard. Only a real Flux project
      // qualifies (same marker requireProject uses); anything else clears the slot.
      const ab = root ? path.resolve(String(root)) : null;
      if (!ab || !fs.existsSync(path.join(ab, "project.json"))) {
        setPendingRoot(null);
        return false;
      }
      setPendingRoot(ab);
      return true;
    });
  }

  return {
    noteWrite,
    atomicWriteMain,
    isSelfWrite,
    fsGuard,
    approveDir,
    clearApprovals: () => approvedDirs.clear(),
    registerHandlers,
  };
}

module.exports = { createFileCore, TMP_WRITE_RE };
