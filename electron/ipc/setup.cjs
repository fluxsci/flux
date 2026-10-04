"use strict";
// setup:* — the "Set up Flux…" window (2026-10-03). Flux is installed by one curl line; this
// window then gets the optional companions without a terminal or admin rights: the `flux`
// command on PATH, Quarto (Word export, `flux compile`), TinyTeX (Quarto PDF), and a look at
// which AI agents are installed. Detection and installers live in ../managedTools.cjs (shared
// with flux-core); this file owns only the IPC surface, one-at-a-time tasks and progress pushes.
const tools = require("../managedTools.cjs");

function createSetupFamily({ isPackaged, readPrefs, fluxConfigPath, installLaunchers, env = process.env }) {
  const running = new Map(); // task → AbortController

  async function status() {
    const prefs = (() => { try { return readPrefs() || {}; } catch { return {}; } })();
    const quarto = tools.resolveQuartoSync({ fluxConfigPath: fluxConfigPath() });
    const version = quarto.command ? await tools.quartoVersion(quarto.command) : "";
    return {
      platform: process.platform,
      // Shown once on a packaged app's first launch; FLUX_SHOW_ONBOARDING=1 previews it from source.
      firstRun: !prefs.onboardingCompleted && (isPackaged() || env.FLUX_SHOW_ONBOARDING === "1"),
      launcher: tools.launcherStatusSync(),
      quarto: { installed: !!quarto.command && !!version, origin: quarto.origin, command: quarto.command, version },
      quartoManageable: !!tools.quartoAsset(),
      quartoPinned: tools.QUARTO.version,
      tex: tools.detectTexSync(),
      agents: { claude: !!tools.findExecutableSync("claude"), codex: !!tools.findExecutableSync("codex") },
      busy: [...running.keys()],
    };
  }

  function task(name, run) {
    if (running.has(name)) throw new Error(`${name} is already running`);
    const controller = new AbortController();
    running.set(name, controller);
    return run(controller.signal).finally(() => running.delete(name));
  }

  function registerHandlers(ipcMain) {
    ipcMain.handle("setup:status", () => status());
    ipcMain.handle("setup:addToTerminal", async () => {
      await installLaunchers([], { createConvenience: true });
      const line = tools.ensurePathLine();
      return { ...tools.launcherStatusSync(), profileChanged: line.changed };
    });
    ipcMain.handle("setup:installQuarto", (e) => task("quarto", async (signal) => {
      const push = (p) => { if (!e.sender.isDestroyed()) e.sender.send("setup:progress", { task: "quarto", ...p }); };
      try {
        const r = await tools.installManagedQuarto({ fluxConfigPath: fluxConfigPath(), signal, onProgress: push });
        return { ok: true, version: r.version };
      } catch (error) {
        return { ok: false, cancelled: signal.aborted, error: signal.aborted ? "Cancelled" : error.message };
      }
    }));
    ipcMain.handle("setup:installTinytex", (e) => task("tinytex", async (signal) => {
      const quarto = tools.resolveQuartoSync({ fluxConfigPath: fluxConfigPath() }).command;
      const push = (chunk) => {
        const line = String(chunk).split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
        if (line && !e.sender.isDestroyed()) e.sender.send("setup:progress", { task: "tinytex", phase: "log", line: line.slice(0, 200) });
      };
      const r = await tools.installTinytex({ quarto, signal, onLog: push });
      return { ok: r.ok, cancelled: signal.aborted, error: r.ok ? undefined : (signal.aborted ? "Cancelled" : (r.log.trim().split("\n").pop() || `quarto exited ${r.code}`)) };
    }));
    ipcMain.handle("setup:cancel", (_e, name) => {
      const c = running.get(String(name));
      if (!c) return false;
      c.abort();
      return true;
    });
  }
  return { registerHandlers, status, dispose: () => { for (const c of running.values()) c.abort(); } };
}

module.exports = { createSetupFamily };
