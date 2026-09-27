"use strict";
// The live agent context bridge: a loopback control server per open project.
// The renderer publishes context and answers live commands.

/**
 * deps:
 *   rootForSender     — (e) => the sender window's open project root | null
 *   appendJournalLine — provenance journal (project family owns it)
 *   noteWrite         — FILES-family self-write TTL (bridge.json writes)
 */
function createAgentFamily({ rootForSender, appendJournalLine, noteWrite }) {
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
  const contextPending = new Map(); // read-only capture handshakes, separate from dispatch

  function stopBridgeEntry(root) {
    const entry = bridges.get(root);
    if (!entry) return;
    bridges.delete(root);
    try {
      entry.bridge.stop();
    } catch {
      /* ignore */
    }
    for (const pending of [dispatchPending, contextPending]) for (const [id, p] of [...pending]) {
      if (p.root !== root) continue;
      pending.delete(id);
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
    const assertOwner = () => {
      if (bridges.get(root) !== entry || win.isDestroyed() || win.webContents.isDestroyed())
        throw new Error("bridge project ownership changed");
    };
    entry.bridge = startBridge({
      root,
      getContext: () => entry.latestContext,
      prepareCapture: () => new Promise((resolve, reject) => {
        assertOwner();
        const id = ++dispatchSeq;
        const timer = setTimeout(() => {
          contextPending.delete(id);
          reject(new Error("live-view-unavailable: renderer timed out"));
        }, 4000);
        contextPending.set(id, { resolve, reject, timer, root, sender: win.webContents });
        win.webContents.send("bridge:context:request", { id });
      }),
      capture: () => { assertOwner(); return win.webContents.capturePage(); },
      onCaptured: event => {
        assertOwner();
        appendJournalLine(root, { action: "live_view", client: event.client, sessionId: event.sessionId });
        win.webContents.send("bridge:viewed", event);
      },
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
      if (!entry || entry.win.webContents !== e.sender) return;
      entry.latestContext = ctx;
      entry.bridge.pushContext(ctx);
    });
    ipc.on("bridge:context:reply", (e, { id, context, allowed }) => {
      const p = contextPending.get(id);
      if (!p || p.sender !== e.sender) return;
      contextPending.delete(id);
      clearTimeout(p.timer);
      if (rootForSender(e) !== p.root || context?.projectRoot !== p.root)
        p.reject(new Error("bridge project ownership changed"));
      else p.resolve({ stamp: context, allowed: allowed === true });
    });
    ipc.on("bridge:dispatch:reply", (_e, { id, result, error }) => {
      const p = dispatchPending.get(id);
      if (!p) return;
      dispatchPending.delete(id);
      clearTimeout(p.timer);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    });
  }

  function bridgeForSender(e) {
    const entry = bridges.get(rootForSender(e));
    return !!entry && entry.win.webContents.id === e.sender.id && entry.bridge.isRunning();
  }
  return { registerHandlers, setBridgeFor, stopBridgeForWindow, stopAllBridges, bridgeForSender };
}

module.exports = { createAgentFamily };
