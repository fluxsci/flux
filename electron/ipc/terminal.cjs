"use strict";
// WS-9.4b: the TERMINAL (PTY) family — session registry, reaper, and the
// pty:* handlers — extracted verbatim from main.cjs. The agent terminal is a
// real login-shell PTY; a session outlives margin view switches (the renderer
// keeps one alive) and is reaped with its window / on quit.

const path = require("node:path");
const fs = require("node:fs");
const { resolvePtySpawn } = require("../execResolve.cjs");
void path;

/**
 * deps:
 *   app            — Electron app (home path)
 *   nodePty        — @lydell/node-pty (or null when unavailable)
 *   getCurrentRoot — () => open project root | null (default cwd)
 */
function createTerminalFamily({ app, nodePty, getCurrentRoot }) {
  const ptySessions = new Map(); // id -> { pty, wc }
  let ptySeq = 0;
  
  function defaultShell() {
    if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
    if (process.env.SHELL) return process.env.SHELL;
    return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  }
  
  // Kill + forget sessions matching `pred` (all of them when `pred` is omitted).
  function reapPtys(pred) {
    for (const [id, s] of [...ptySessions]) {
      if (!pred || pred(s)) {
        try {
          s.pty.kill();
        } catch {
          /* already gone */
        }
        ptySessions.delete(id);
      }
    }
  }
  
  
  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
  ipc.handle("pty:create", (e, opts = {}) => {
      if (!nodePty) return { ok: false, error: "Terminal backend unavailable (node-pty not loaded)." };
      const wc = e.sender;
      // Optional command (e.g. the agent drawer spawns `claude`); default = the login shell.
      // An explicit command goes through resolvePtySpawn (identity off win32) so a
      // .cmd shim like npm's `claude` launches; the default shell is spawned as-is.
      let command = defaultShell();
      let cmdArgs = Array.isArray(opts.args) ? opts.args.map(String) : [];
      if (typeof opts.command === "string" && opts.command.trim()) {
        const r = resolvePtySpawn(opts.command.trim(), cmdArgs);
        command = r.command;
        cmdArgs = r.args;
      }
      // Open in the requested dir, else the open project root, else home.
      const wanted = opts.cwd;
      const projRoot = getCurrentRoot();
      const cwd =
        wanted && fs.existsSync(wanted)
          ? wanted
          : projRoot && fs.existsSync(projRoot)
            ? projRoot
            : app.getPath("home");
      const cols = Math.max(1, opts.cols | 0) || 80;
      const rows = Math.max(1, opts.rows | 0) || 24;
      let child;
      try {
        child = nodePty.spawn(command, cmdArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            TERM_PROGRAM: "Flux", // flux-cap-ok (display name, not a path)
            COLORTERM: "truecolor",
            ...(opts.env && typeof opts.env === "object" ? opts.env : {}),
          },
        });
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
      const id = `pty${++ptySeq}`;
      ptySessions.set(id, { pty: child, wc });
      child.onData((data) => {
        if (!wc.isDestroyed()) wc.send("pty:data", { id, data });
      });
      child.onExit(({ exitCode, signal }) => {
        if (!wc.isDestroyed()) wc.send("pty:exit", { id, exitCode, signal });
        ptySessions.delete(id);
      });
      // SHL-18: report the shell/command actually launched (a path string), NOT the imported
      // electron `shell` module — the renderer's TermInfo.shell expects the former.
      return { ok: true, id, shell: command, cwd, pid: child.pid };
    });
    
    ipc.on("pty:write", (_e, id, data) => {
      const s = ptySessions.get(id);
      if (s) {
        try {
          s.pty.write(data);
        } catch {
          /* closed mid-write */
        }
      }
    });
    
    ipc.on("pty:resize", (_e, id, cols, rows) => {
      const s = ptySessions.get(id);
      if (s) {
        try {
          s.pty.resize(Math.max(1, cols | 0) || 80, Math.max(1, rows | 0) || 24);
        } catch {
          /* closed mid-resize */
        }
      }
    });
    
    ipc.handle("pty:kill", (_e, id) => {
      const s = ptySessions.get(id);
      if (s) {
        try {
          s.pty.kill();
        } catch {
          /* already gone */
        }
        ptySessions.delete(id);
      }
      return true;
    });
  }

  return { registerHandlers, reapPtys };
}

module.exports = { createTerminalFamily };
