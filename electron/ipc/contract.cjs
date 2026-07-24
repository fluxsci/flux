"use strict";
// WS-9.4: the ONE declarative IPC channel table — main registration, preload
// exposure, and main→renderer pushes are all checked against it, so a rename
// or addition can never silently orphan one side (the same drift class the
// twin-engine + allow-list rules kill elsewhere).
//
//   kind: "invoke" — ipcMain.handle ↔ preload ipcRenderer.invoke
//         "send"   — ipcMain.on     ↔ preload ipcRenderer.send   (fire-and-forget)
//         "push"   — webContents.send → preload ipcRenderer.on   (main-initiated)
//   scope: coarse capability class ("read" | "write" | "spawn") — documentation
//          + review anchor, not runtime enforcement.
//
// Enforcement:
//   · main: wrapIpcMain(ipcMain) returns {handle, on} that assert the channel
//     is declared with the matching kind at registration, and record it;
//     assertAllRegistered() (called once the app is ready) asserts every
//     declared invoke/send channel actually got a handler.
//   · preload + push sites: checked statically by verify-ipc-contract.ts
//     (pure tier) — it regex-extracts usages from both files and fails on
//     missing/extra/undeclared channels.

const CHANNELS = [
  // --- files (fs:*) ----------------------------------------------------------
  { channel: "fs:exists", kind: "invoke", scope: "read" },
  { channel: "fs:stat", kind: "invoke", scope: "read" },
  { channel: "fs:readdir", kind: "invoke", scope: "read" },
  { channel: "fs:readText", kind: "invoke", scope: "read" },
  { channel: "fs:readFile", kind: "invoke", scope: "read" },
  { channel: "fs:writeText", kind: "invoke", scope: "write" },
  { channel: "fs:writeFile", kind: "invoke", scope: "write" },
  { channel: "fs:mkdir", kind: "invoke", scope: "write" },
  { channel: "fs:remove", kind: "invoke", scope: "write" },
  { channel: "fs:fsyncDir", kind: "invoke", scope: "write" },
  { channel: "fs:beginOpen", kind: "invoke", scope: "read" },
  { channel: "fs:changed", kind: "push", scope: "read" },
  // --- dialogs / shell -------------------------------------------------------
  { channel: "dlg:open", kind: "invoke", scope: "read" },
  { channel: "dlg:save", kind: "invoke", scope: "write" },
  { channel: "shell:openExternal", kind: "invoke", scope: "spawn" },
  { channel: "shell:showItemInFolder", kind: "invoke", scope: "spawn" },
  // Open a context/config file in the OS default editor (FluxConfig-rooted only).
  { channel: "shell:openPath", kind: "invoke", scope: "spawn" },
  // Launch the Lighttable sidecar app (lighttable/ in the source checkout). A
  // convenience spawn only — no code or state crosses the sidecar boundary.
  { channel: "lighttable:launch", kind: "invoke", scope: "spawn" },
  // --- project lifecycle / watcher / locks / journal ---------------------------
  { channel: "watch:setRoot", kind: "invoke", scope: "read" },
  // The feedback ledger (append-only .meta/feedback.ndjson — principal-agent scheme).
  { channel: "feedback:append", kind: "invoke", scope: "write" },
  { channel: "lock:acquire", kind: "invoke", scope: "write" },
  { channel: "lock:release", kind: "invoke", scope: "write" },
  { channel: "lock:set", kind: "invoke", scope: "write" },
  { channel: "journal:append", kind: "invoke", scope: "write" },
  { channel: "config:move", kind: "invoke", scope: "write" },
  { channel: "prefs:get", kind: "invoke", scope: "read" },
  { channel: "prefs:set", kind: "invoke", scope: "write" },
  { channel: "app:paths", kind: "invoke", scope: "read" },
  { channel: "app:error", kind: "push", scope: "read" },
  { channel: "app:flush", kind: "push", scope: "read" },
  { channel: "app:flush:done", kind: "send", scope: "read" },
  { channel: "update:check", kind: "invoke", scope: "read" },
  // --- window chrome -----------------------------------------------------------
  { channel: "win:minimize", kind: "invoke", scope: "read" },
  { channel: "win:maximizeToggle", kind: "invoke", scope: "read" },
  { channel: "win:close", kind: "invoke", scope: "read" },
  { channel: "win:isMaximized", kind: "invoke", scope: "read" },
  { channel: "win:maximized", kind: "push", scope: "read" },
  { channel: "win:setDocumentEdited", kind: "send", scope: "read" },
  // --- network / citations / acquisition ---------------------------------------
  { channel: "pdf:netGet", kind: "invoke", scope: "read" },
  { channel: "pdf:fetchViaProxy", kind: "invoke", scope: "read" },
  { channel: "proxy:login", kind: "invoke", scope: "read" },
  { channel: "proxy:status", kind: "invoke", scope: "read" },
  { channel: "proxy:cancel", kind: "invoke", scope: "read" },
  { channel: "proxy:hasCredentials", kind: "invoke", scope: "read" },
  { channel: "proxy:setCredentials", kind: "invoke", scope: "write" },
  { channel: "proxy:clearCredentials", kind: "invoke", scope: "write" },
  { channel: "cite:fetchDoi", kind: "invoke", scope: "read" },
  { channel: "cite:fetchDoiBibtex", kind: "invoke", scope: "read" },
  { channel: "cite:openalex", kind: "invoke", scope: "read" },
  { channel: "cite:s2", kind: "invoke", scope: "read" },
  { channel: "cite:resolveUrl", kind: "invoke", scope: "read" },
  { channel: "keys:get", kind: "invoke", scope: "read" },
  { channel: "keys:set", kind: "invoke", scope: "write" },
  { channel: "fulltext:search", kind: "invoke", scope: "read" },
  // --- capture (flux:// deep links) ---------------------------------------------
  { channel: "capture:add", kind: "push", scope: "read" },
  // --- agent bridge ---------------------------------------------------------------
  // The principal drawer's launch spec (agents.json roster + boot prompt + MCP wiring).
  { channel: "agent:principalSpec", kind: "invoke", scope: "read" },
  { channel: "bridge:dispatch", kind: "push", scope: "read" },
  { channel: "bridge:dispatch:reply", kind: "send", scope: "read" },
  { channel: "bridge:context", kind: "send", scope: "read" },
  // --- terminal (PTY) --------------------------------------------------------------
  { channel: "pty:create", kind: "invoke", scope: "spawn" },
  { channel: "pty:write", kind: "send", scope: "spawn" },
  { channel: "pty:resize", kind: "send", scope: "spawn" },
  { channel: "pty:kill", kind: "invoke", scope: "spawn" },
  { channel: "pty:data", kind: "push", scope: "read" },
  { channel: "pty:exit", kind: "push", scope: "read" },
  // --- renders / exports -------------------------------------------------------------
  { channel: "recipe:run", kind: "invoke", scope: "spawn" },
  { channel: "quarto:available", kind: "invoke", scope: "read" },
  { channel: "quarto:render", kind: "invoke", scope: "spawn" },
  { channel: "print:pdf", kind: "invoke", scope: "write" },
  { channel: "export:pdf", kind: "invoke", scope: "write" },
  { channel: "slides:exportDeck", kind: "invoke", scope: "spawn" },
  // --- text styles (machine-global library) --------------------------------------------
  { channel: "textstyles:get", kind: "invoke", scope: "read" },
  { channel: "textstyles:set", kind: "invoke", scope: "write" },
  // --- design presets (<FluxConfig>/presets/designs/**.json) ---------------------------
  { channel: "presets:list", kind: "invoke", scope: "read" },
  { channel: "presets:save", kind: "invoke", scope: "write" },
  { channel: "presets:delete", kind: "invoke", scope: "write" },
  // --- animation presets + templates (<FluxConfig>/presets/animations|anim-templates) --
  // One trio; the payload's `kind` ("preset" | "template") picks the path root.
  { channel: "animlib:list", kind: "invoke", scope: "read" },
  { channel: "animlib:save", kind: "invoke", scope: "write" },
  { channel: "animlib:delete", kind: "invoke", scope: "write" },
  // --- slide presets (<FluxConfig>/presets/slides/**.json) -----------------------------
  { channel: "slidelib:list", kind: "invoke", scope: "read" },
  { channel: "slidelib:save", kind: "invoke", scope: "write" },
  { channel: "slidelib:delete", kind: "invoke", scope: "write" },
];

const byChannel = new Map(CHANNELS.map((c) => [c.channel, c]));

/** Wrap ipcMain so registration is contract-checked and recorded. */
function wrapIpcMain(ipcMain) {
  const registered = new Set();
  const expectKind = (channel, kind, method) => {
    const decl = byChannel.get(channel);
    if (!decl) throw new Error(`IPC contract: ${method}("${channel}") is not declared in electron/ipc/contract.cjs`);
    if (decl.kind !== kind)
      throw new Error(`IPC contract: "${channel}" is declared kind:"${decl.kind}" but registered via ${method}`);
    registered.add(channel);
  };
  return {
    handle(channel, fn) {
      expectKind(channel, "invoke", "handle");
      return ipcMain.handle(channel, fn);
    },
    on(channel, fn) {
      expectKind(channel, "send", "on");
      return ipcMain.on(channel, fn);
    },
    /** Every declared invoke/send channel must have a live handler by app-ready. */
    assertAllRegistered() {
      const missing = CHANNELS.filter((c) => c.kind !== "push" && !registered.has(c.channel));
      if (missing.length)
        throw new Error(`IPC contract: declared but never registered: ${missing.map((c) => c.channel).join(", ")}`);
    },
  };
}

module.exports = { CHANNELS, wrapIpcMain };
