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
 *   roots     — () => extra allowed root dirs (main supplies every window's
 *               root + pending root, FluxConfig, FluxLib — lifecycle state it owns)
 *   setPendingRoot — (senderId, abs|null) => void  (fs:beginOpen writes main's
 *               per-window slot)
 *   windowFor — (e) => BrowserWindow|null (dialog parenting; optional)
 */
function createFileCore({ app, dialog, roots, setPendingRoot, windowFor }) {
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
  // Multi-window: approvals are PER WINDOW (keyed by webContents id) — a dir the
  // user reached through window A's dialog must not become writable from window
  // B, and window B's project switch must not revoke window A's in-flight
  // approvals. (The roots() union stays global by design — see main.cjs.)
  const approvedDirs = new Map(); // senderId -> Set<abs dir>
  function approveDir(senderId, p) {
    if (!p) return;
    let set = approvedDirs.get(senderId);
    if (!set) approvedDirs.set(senderId, (set = new Set()));
    set.add(path.resolve(path.dirname(p)));
  }
  // Windows filesystems are case-insensitive (and a dialog result vs. a
  // renderer-echoed path can differ in drive-letter case), so containment
  // folds case there; POSIX keeps today's exact case-sensitive compare.
  const foldCase = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  function underDir(ab, dir) {
    const a = foldCase(ab);
    const d = foldCase(dir);
    return a === d || a.startsWith(d + path.sep);
  }
  function fsGuard(p, senderId) {
    // WS-9.3: deny-by-default. The old currentRoot-null early-return allowed
    // EVERYTHING in the launch→open window (and on Home) — the app dirs +
    // FluxLib (via roots()) are all Home actually needs.
    const ab = path.resolve(p);
    // W12 (SHL-6): $HOME is deliberately NOT a root — allowing the entire user home
    // made the guard nearly a no-op. Imports/exports outside the project still work
    // because a file dialog `approveDir`s the chosen directory — for the SENDER's
    // window only (senderId; undefined = no dialog approvals apply).
    const approved = senderId != null ? (approvedDirs.get(senderId) ?? []) : [];
    const all = [app.getPath("userData"), app.getPath("temp"), ...roots(), ...approved].filter(Boolean);
    if (all.some((r) => underDir(ab, path.resolve(r)))) return;
    throw new Error(`refused path outside project/app roots: ${p}`);
  }

  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
    ipc.handle("dlg:open", async (e, opts) => {
      // Parent to the REQUESTING window (multi-window: the focused window may
      // be a different project entirely).
      const res = await dialog.showOpenDialog(windowFor?.(e) ?? undefined, {
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
      res.filePaths.forEach((p) => approveDir(e.sender.id, p));
      return opts.multiple ? res.filePaths : res.filePaths[0];
    });

    ipc.handle("dlg:save", async (e, opts) => {
      const res = await dialog.showSaveDialog(windowFor?.(e) ?? undefined, {
        defaultPath: opts.defaultPath,
        filters: opts.filters,
        title: opts.title,
      });
      if (res.canceled) return null;
      approveDir(e.sender.id, res.filePath); // M9: allow writing the chosen export + sidecars
      return res.filePath;
    });

    ipc.handle("fs:readFile", async (e, p) => {
      fsGuard(p, e.sender.id);
      const buf = await fs.promises.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });
    ipc.handle("fs:writeFile", async (e, p, data) => {
      fsGuard(p, e.sender.id);
      noteWrite(p);
      await atomicWriteMain(p, Buffer.from(data));
    });
    ipc.handle("fs:readText", async (e, p) => {
      fsGuard(p, e.sender.id);
      return fs.promises.readFile(p, "utf8");
    });
    ipc.handle("fs:writeText", async (e, p, text) => {
      fsGuard(p, e.sender.id);
      noteWrite(p);
      await atomicWriteMain(p, Buffer.from(String(text), "utf8"));
    });
    // The feedback ledger is APPEND-only (event-sourced NDJSON): O_APPEND keeps
    // concurrent writers safe (the app adding notes while an agent appends
    // resolves), which an atomic read-modify-write could not.
    ipc.handle("feedback:append", async (e, p, line) => {
      fsGuard(p, e.sender.id);
      noteWrite(p);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.appendFile(p, String(line));
      return true;
    });
    ipc.handle("fs:mkdir", async (e, p) => {
      fsGuard(p, e.sender.id);
      await fs.promises.mkdir(p, { recursive: true });
    });
    // WS-5.3: atomicWriteMain fsyncs the FILE, but on Linux/mac a crash right
    // after the rename can still lose the DIRECTORY entry — callers fsync the
    // parent dir once per write batch. Best-effort; no-op on win32 (no dir fsync).
    ipc.handle("fs:fsyncDir", async (e, p) => {
      fsGuard(p, e.sender.id);
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
    ipc.handle("fs:exists", async (e, p) => {
      fsGuard(p, e.sender.id); // W12 (SHL-6): was unguarded — an existence-probe of any path
      try {
        await fs.promises.access(p);
        return true;
      } catch (err) {
        // SHL-18: only ENOENT means "not there". EACCES/EPERM etc. mean the path EXISTS but isn't
        // accessible — reporting that as absent would let a caller wrongly treat it as free to create.
        return !!(err && err.code && err.code !== "ENOENT");
      }
    });
    ipc.handle("fs:stat", async (e, p) => {
      fsGuard(p, e.sender.id);
      try {
        const st = await fs.promises.stat(p);
        return { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null; // absent (or blocked) — callers treat null as "no cacheable identity"
      }
    });
    ipc.handle("fs:readdir", async (e, p) => {
      fsGuard(p, e.sender.id); // W12 (SHL-6): was unguarded — a directory-listing of any path
      try {
        const es = await fs.promises.readdir(p, { withFileTypes: true });
        return es.map((ent) => ({ name: ent.name, dir: ent.isDirectory() }));
      } catch {
        return [];
      }
    });
    // Delete a file (used to clear a paper's fetch-failure record on a later success). Guarded
    // to the same project/app roots as every other write; a missing file is a no-op success.
    ipc.handle("fs:remove", async (e, p) => {
      fsGuard(p, e.sender.id);
      try {
        await fs.promises.rm(p, { force: true });
      } catch {
        /* already gone / unremovable — treat as removed */
      }
    });

    ipc.handle("fs:beginOpen", async (e, root) => {
      // WS-9.3: pre-register the project the renderer is about to load, so the
      // load's fs:* reads pass the deny-by-default guard. Only a real Flux project
      // qualifies (same marker requireProject uses); anything else clears the
      // sender's slot (per-window — see main.cjs pendingRoots).
      const ab = root ? path.resolve(String(root)) : null;
      if (!ab || !fs.existsSync(path.join(ab, "project.json"))) {
        setPendingRoot(e.sender.id, null);
        return false;
      }
      setPendingRoot(e.sender.id, ab);
      return true;
    });
  }

  return {
    noteWrite,
    atomicWriteMain,
    isSelfWrite,
    fsGuard,
    approveDir,
    underDir,
    /** Drop ONE window's dialog approvals (its project switch or close). */
    clearApprovals: (senderId) => {
      approvedDirs.delete(senderId);
    },
    registerHandlers,
  };
}

module.exports = { createFileCore, TMP_WRITE_RE };
