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
 *   rootForSender     — (e) => the sender window's open project root | null
 *   appendJournalLine — provenance journal (project family owns it)
 *   noteWrite         — FILES-family self-write TTL (bridge.json writes)
 *   appRoot           — absolute repo/app root (dist/flux-mcp.mjs resolution)
 */
function createAgentFamily({ app, rootForSender, appendJournalLine, noteWrite, appRoot }) {
// ---------------------------------------------------------------------------
  // WS4: live agent context bridge. The renderer pushes its UI context up (cached
  // here) and answers dispatch requests; an external agent (the Flux MCP server)
  // talks to a loopback control server started per open project. See bridgeServer.cjs.
  //
  // Multi-window (2026-08-11): ONE bridge per open project, each pinned to the
  // window that opened it — the old module singleton meant window B's project
  // open tore down window A's live bridge. Bridges write per-root on disk
  // (<root>/.meta/live/bridge.json), so entries never collide there; only this
  // map held them one-at-a-time. Roots are unique across windows (the renderer
  // focuses an existing window instead of double-opening — win:projectOpenElsewhere).
  // ---------------------------------------------------------------------------
  const { startBridge } = require("../bridgeServer.cjs");
  const bridges = new Map(); // root -> { bridge, latestContext, win }
  let dispatchSeq = 0;
  const dispatchPending = new Map(); // id -> { resolve, reject, timer, root }

  function stopBridgeEntry(root) {
    const entry = bridges.get(root);
    if (!entry) return;
    bridges.delete(root);
    try {
      entry.bridge.stop();
    } catch {
      /* ignore */
    }
    for (const [id, p] of [...dispatchPending]) {
      if (p.root !== root) continue;
      dispatchPending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error("bridge stopped"));
    }
  }

  /** watch:setRoot: swap the bridge OWNED BY THIS WINDOW to `root` (null stops it). */
  function setBridgeFor(root, win) {
    for (const [r, entry] of [...bridges]) if (entry.win === win) stopBridgeEntry(r);
    if (!root) return;
    stopBridgeEntry(root); // a stale entry for this root (defensive — see map comment)
    const entry = { bridge: null, latestContext: null, win };
    entry.bridge = startBridge({
      root,
      getContext: () => entry.latestContext,
      dispatch: (command) =>
        new Promise((resolve, reject) => {
          if (entry.win.isDestroyed() || entry.win.webContents.isDestroyed())
            return reject(new Error("no renderer"));
          const id = ++dispatchSeq;
          const timer = setTimeout(() => {
            dispatchPending.delete(id);
            reject(new Error("dispatch timed out"));
          }, 12000);
          dispatchPending.set(id, { resolve, reject, timer, root });
          appendJournalLine(root, {
            action: `dispatch:${command && command.type}`,
            client: "agent",
            target: (command && (command.figureId || command.partId)) || undefined,
          });
          entry.win.webContents.send("bridge:dispatch", { id, command });
        }),
      noteWrite,
    });
    bridges.set(root, entry);
  }

  /** Window teardown: stop the bridge(s) this window owns (its `closed` handler). */
  function stopBridgeForWindow(win) {
    for (const [r, entry] of [...bridges]) if (entry.win === win) stopBridgeEntry(r);
  }

  /** Quit/signal teardown: every bridge.json (+ token) must leave the disk. */
  function stopAllBridges() {
    for (const r of [...bridges.keys()]) stopBridgeEntry(r);
  }

  /** Register the family's channels on the (contract-wrapped) ipc. */
  function registerHandlers(ipc) {
    ipc.on("bridge:context", (e, ctx) => {
      // The context belongs to the SENDER's project — route by its root.
      const root = rootForSender(e);
      const entry = root ? bridges.get(root) : undefined;
      if (!entry) return;
      entry.latestContext = ctx;
      entry.bridge.pushContext(ctx);
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
    // Principal-agent scheme: how the renderer resolves the USER'S
    // configured principal for the open project (the palette's copy-prompt +
    // the real-app gate; the interactive launch itself is `flux principal` in
    // the user's own terminal — the in-app drawer was retired 2026-07-20).
    // Two modes:
    //   {probe:true}       → roster info (families' menus + standing selection)
    //   {selection?}       → the resolved launch spec (family templates on the
    //                        new schema, fixed entries on legacy rosters), with
    //                        the boot prompt + worker-policy env; a provided
    //                        selection is persisted as last-used.
    ipc.handle("agent:principalSpec", (e, opts) => {
      const root = rootForSender(e);
      if (!root || !fs.existsSync(root)) return { ok: false, error: "no open project" };
      const cfg = fluxPaths.resolveFluxConfigPathSync();
      const roster = agentsConfig.readAgentsConfigSync(cfg);
      const standing = agentsConfig.standingSelectionSync(cfg, roster);
      if (opts && opts.probe) {
        const families = {};
        for (const [name, fam] of Object.entries(roster.families || {})) {
          families[name] = { models: fam.models || [], efforts: fam.efforts || [] };
        }
        return { ok: true, probe: true, legacy: !!roster.legacy, families, selection: standing, warning: roster.warning };
      }
      const selection = (opts && opts.selection) || standing;
      const mcp = mcpSpecFor(root);
      try {
        const cli = fluxPaths.resolveOwnCliCommandsSync().cli;
        const workerNote = agentsConfig.workerMenuNote(roster, selection.worker, cli);
        const prompt = agentsConfig.principalBootPrompt(root, cli, workerNote);
        const common = {
          prompt,
          projectRoot: root,
          mcpSpec: mcp.ok ? { command: mcp.command, args: mcp.args, env: mcp.env } : null,
          client: "principal",
          extraEnv: { FLUX_WORKER_POLICY: agentsConfig.workerPolicyEnv(selection.worker) },
        };
        const spec = roster.legacy
          ? agentsConfig.resolveAgentSpec(roster.principal, common)
          : agentsConfig.resolveFamilyLaunch(roster, "interactive", selection.principal, common);
        if (opts && opts.selection) agentsConfig.writeLastUsedSync(cfg, selection);
        // `prompt` rides along so the renderer can offer copy-to-clipboard (the
        // user pasting it into their own terminal session).
        return { ok: true, ...spec, prompt, warning: roster.warning, agentsPath: roster.path };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  }

  // How a principal launch embeds the flux MCP server for the open project
  // ({mcpJson} roster placeholder; the agent spawns the server itself — cwd is
  // its own, so every path must be absolute). Dev: the repo's tsx bin runs
  // flux-mcp.ts. Packaged: a bundled dist/flux-mcp.mjs (asar-unpacked, like
  // flux-cli.mjs) on Electron-as-Node.
  function mcpSpecFor(root) {
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
    // npm's .bin/tsx is an extensionless sh script; the spawnable Windows twin
    // is tsx.cmd (the MCP consumer launches whatever path we hand it).
    const tsxBin = path.join(
      appRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    const entry = path.join(appRoot, "flux-mcp.ts");
    if (!app.isPackaged && fs.existsSync(tsxBin) && fs.existsSync(entry)) {
      return { ok: true, projectRoot, command: tsxBin, args: [entry, projectRoot] };
    }
    return { ok: false, projectRoot };
  }

  return { registerHandlers, setBridgeFor, stopBridgeForWindow, stopAllBridges };
}

module.exports = { createAgentFamily };
