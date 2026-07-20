// Electron entry for verify-principal-electron.cjs: boots the REAL app
// (electron/main.cjs — nothing mocked), then drives the PRELOAD bridge to
// verify the principal launch chain end-to-end: agents.json roster (scratch
// $HOME) → agent:principalSpec (placeholders, boot prompt, MCP wiring, cwd
// rule) → pty:create spawns the stub principal → pty:data flows back.
// Prints PROBE lines the runner parses; §9 doctrine: POSITIVE boot evidence.
"use strict";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";

let uncaught = 0;
process.on("uncaughtException", (e) => {
  uncaught++;
  console.log(`PROBE uncaught=${uncaught} msg=${String((e && e.message) || e).slice(0, 120)}`);
});

const projectDir = process.env.PROBE_PROJECT;
if (!projectDir) {
  console.log("PROBE fatal=no PROBE_PROJECT env");
  process.exit(2);
}

require("../../electron/main.cjs");

const { app, BrowserWindow } = require("electron");

async function driven() {
  // Wait for the real window with a real title (positive evidence, not
  // absence-of-errors).
  let win = null;
  for (let i = 0; i < 120; i++) {
    win = BrowserWindow.getAllWindows()[0] ?? null;
    if (win && !win.webContents.isLoading()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!win) {
    console.log("PROBE windows=0");
    app.exit(3);
    return;
  }
  console.log(`PROBE windows=${BrowserWindow.getAllWindows().length} title=${win.getTitle() || "Flux"}`); // flux-cap-ok (display string)

  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const out = {};
      try {
        // Register the project (sets main's currentRoot — the principalSpec anchor).
        out.watched = await window.fig.watchRoot(${JSON.stringify(projectDir)});
        // Picker probe: families + standing selection for the drawer UI.
        const probe = await window.fig.agentPrincipalSpec({ probe: true });
        out.probe = !!(probe.ok && probe.probe && probe.families.stub && probe.selection.principal.model);
        const spec = await window.fig.agentPrincipalSpec();
        out.spec = { ok: spec.ok, error: spec.error ?? null, command: spec.command, cwd: spec.cwd,
                     promptArg: (spec.args ?? []).find((a) => a.includes("Principal")) ? "yes" : "no" };
        if (!spec.ok) return out;
        const data = [];
        const offData = window.fig.term.onData((m) => { if (m.id === out.ptyId) data.push(m.data); });
        let exited = null;
        const offExit = window.fig.term.onExit((m) => { if (m.id === out.ptyId) exited = m.exitCode; });
        const res = await window.fig.term.create({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, cols: 100, rows: 30 });
        out.create = res.ok ? { ok: true, cwd: res.cwd, pid: res.pid } : { ok: false, error: res.error };
        if (res.ok) {
          out.ptyId = res.id;
          // Give the stub principal a moment to emit, then reap.
          await new Promise((r) => setTimeout(r, 2500));
          out.output = data.join("");
          out.exited = exited;
          await window.fig.term.kill(res.id).catch(() => {});
        }
        offData(); offExit();
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      return out;
    })()`,
    true,
  );
  console.log("PROBE result=" + JSON.stringify(result));
  console.log(`PROBE uncaughtTotal=${uncaught}`);
  app.exit(0);
}

app.whenReady().then(() => {
  setTimeout(() => void driven().catch((e) => {
    console.log("PROBE fatal=" + String((e && e.message) || e).slice(0, 200));
    app.exit(4);
  }), 1500);
});

// Hard watchdog: a hung compositor must not hang the gate (§9).
setTimeout(() => {
  console.log("PROBE fatal=watchdog-timeout");
  process.exit(5);
}, 90_000);
