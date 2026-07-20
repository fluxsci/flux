"use strict";
// WS-9.4b: the AGENT family — the live agent context bridge (loopback control
// server per open project; renderer pushes context, answers dispatches) and
// agent:mcpSpec (how `claude` launches the flux MCP server) — extracted
// verbatim from main.cjs. Channel names and behavior unchanged.

const path = require("node:path");
const fs = require("node:fs");
const fluxPaths = require("../fluxPaths.cjs");
const agentsConfig = require("../agentsConfig.cjs");

/**
 * deps:
 *   app               — Electron app (isPackaged, home path)
 *   getMainWindow     — () => BrowserWindow | null (dispatch target)
 *   getCurrentRoot    — () => open project root | null (mcpSpec cwd)
 *   appendJournalLine — provenance journal (project family owns it)
 *   noteWrite         — FILES-family self-write TTL (bridge.json writes)
 *   appRoot           — absolute repo/app root (dist/flux-mcp.mjs resolution)
 */
function createAgentFamily({ app, getMainWindow, getCurrentRoot, appendJournalLine, noteWrite, appRoot }) {
// ---------------------------------------------------------------------------
  // WS4: live agent context bridge. The renderer pushes its UI context up (cached
  // here) and answers dispatch requests; an external agent (the Flux MCP server)
  // talks to a loopback control server started per open project. See bridgeServer.cjs.
  // ---------------------------------------------------------------------------
  const { startBridge } = require("../bridgeServer.cjs");
  let bridge = null;
  let latestContext = null;
  let dispatchSeq = 0;
  const dispatchPending = new Map(); // id -> { resolve, reject, timer }
  
  function stopBridge() {
    if (bridge) {
      try {
        bridge.stop();
      } catch {
        /* ignore */
      }
      bridge = null;
    }
    for (const { reject, timer } of dispatchPending.values()) {
      clearTimeout(timer);
      reject(new Error("bridge stopped"));
    }
    dispatchPending.clear();
    latestContext = null;
  }
  
  function startBridgeFor(root) {
    stopBridge();
    if (!root) return;
    bridge = startBridge({
      root,
      getContext: () => latestContext,
      dispatch: (command) =>
        new Promise((resolve, reject) => {
          if (!getMainWindow() || getMainWindow().webContents.isDestroyed()) return reject(new Error("no renderer"));
          const id = ++dispatchSeq;
          const timer = setTimeout(() => {
            dispatchPending.delete(id);
            reject(new Error("dispatch timed out"));
          }, 12000);
          dispatchPending.set(id, { resolve, reject, timer });
          appendJournalLine(root, {
            action: `dispatch:${command && command.type}`,
            client: "agent",
            target: (command && (command.figureId || command.partId)) || undefined,
          });
          getMainWindow().webContents.send("bridge:dispatch", { id, command });
        }),
      noteWrite,
    });
  }

  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
    ipc.on("bridge:context", (_e, ctx) => {
      latestContext = ctx;
      if (bridge) bridge.pushContext(ctx);
    });
    ipc.on("bridge:dispatch:reply", (_e, { id, result, error }) => {
      const p = dispatchPending.get(id);
      if (!p) return;
      dispatchPending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });

    // R3 (FluxReader "Ask Claude"): how a `claude` session should launch the flux MCP
    // server for the open project. The renderer embeds this in `claude --mcp-config`;
    // claude then spawns the server itself (cwd = its own, so every path here must be
    // absolute). Dev: the repo's tsx bin runs flux-mcp.ts. Packaged: a bundled
    // dist/flux-mcp.mjs (asar-unpacked, like flux-cli.mjs) on Electron-as-Node.
    ipc.handle("agent:mcpSpec", () => mcpSpecFor());

    // Principal-agent scheme: how the in-app Agent drawer launches the USER'S
    // configured principal (agents.json roster) for the open project — the
    // roster command with placeholders resolved, the flux MCP spec embedded
    // when the command asks for it ({mcpJson}), the standard boot prompt, and
    // the cwd rule (analysis-workspace parent when it looks like one).
    ipc.handle("agent:principalSpec", () => {
      const root = getCurrentRoot();
      if (!root || !fs.existsSync(root)) return { ok: false, error: "no open project" };
      const cfg = fluxPaths.resolveFluxConfigPathSync();
      const roster = agentsConfig.readAgentsConfigSync(cfg);
      const mcp = mcpSpecFor();
      try {
        const prompt = agentsConfig.principalBootPrompt(root);
        const spec = agentsConfig.resolveAgentSpec(roster.principal, {
          prompt,
          projectRoot: root,
          mcpSpec: mcp.ok ? { command: mcp.command, args: mcp.args, env: mcp.env } : null,
          client: "principal",
        });
        // `prompt` rides along so the renderer can offer copy-to-clipboard (the
        // user pasting it into their own terminal session).
        return { ok: true, ...spec, prompt, warning: roster.warning, agentsPath: roster.path };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  }

  // R3 (FluxReader "Ask Claude") + the principal drawer: how a session should
  // launch the flux MCP server for the open project. The renderer embeds this
  // in `claude --mcp-config`; claude then spawns the server itself (cwd = its
  // own, so every path here must be absolute). Dev: the repo's tsx bin runs
  // flux-mcp.ts. Packaged: a bundled dist/flux-mcp.mjs (asar-unpacked, like
  // flux-cli.mjs) on Electron-as-Node.
  function mcpSpecFor() {
    const root = getCurrentRoot();
    const projectRoot = root && fs.existsSync(root) ? root : app.getPath("home");
    const bundled = app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "flux-mcp.mjs")
      : path.join(appRoot, "dist", "flux-mcp.mjs");
    if (fs.existsSync(bundled)) {
      return {
        ok: true,
        projectRoot,
        command: process.execPath,
        args: [bundled, projectRoot],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
    const tsxBin = path.join(appRoot, "node_modules", ".bin", "tsx");
    const entry = path.join(appRoot, "flux-mcp.ts");
    if (!app.isPackaged && fs.existsSync(tsxBin) && fs.existsSync(entry)) {
      return { ok: true, projectRoot, command: tsxBin, args: [entry, projectRoot] };
    }
    return { ok: false, projectRoot };
  }

  return { registerHandlers, startBridgeFor, stopBridge };
}

module.exports = { createAgentFamily };
