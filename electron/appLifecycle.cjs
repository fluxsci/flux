// W6 (V1 review): app-lifecycle glue extracted from main.cjs so the risky bits —
// the quit/close flush handshake state machine and the platform menu template —
// are unit-testable without launching the whole app (scripts/verify-w6-flush.cjs).

/**
 * The quit/close flush handshake. main.cjs holds a window's close, calls
 * `request(win, done)`, and destroys only when `done` fires — which happens
 * either when the renderer acks via `ack(token)` or after `timeoutMs` (so a
 * wedged renderer can never brick quit). One coordinator serves every window;
 * tokens disambiguate concurrent requests.
 */
function createFlushCoordinator({ timeoutMs = 2500 } = {}) {
  let seq = 0;
  const pending = new Map(); // token → finish()

  function request(win, done) {
    // No renderer to flush (already gone / never loaded) → let the close proceed.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      done();
      return;
    }
    const token = ++seq;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(token);
      done();
    };
    const timer = setTimeout(finish, timeoutMs);
    pending.set(token, finish);
    win.webContents.send("app:flush", token);
    return token;
  }

  function ack(token) {
    const finish = pending.get(token);
    if (finish) finish();
  }

  return { request, ack, pendingCount: () => pending.size };
}

/**
 * The application-menu template. Returns `null` (meaning "no menu") or an
 * Electron menu template array; main.cjs feeds it to Menu.buildFromTemplate.
 *
 *   • Linux/Windows draw their own title bar → no menu in production (this is
 *     what removes the still-live default accelerators, notably Ctrl+R reload
 *     and Ctrl+Shift+I, which silently wipe unsaved renderer state). Dev keeps a
 *     hidden View menu so reload/devtools stay reachable.
 *   • macOS needs a menu for the standard app / Edit (Cmd-C/V/X/A/Z) / Window
 *     roles, so it always gets a minimal template. Reload + DevTools appear only
 *     in dev.
 */
function appMenuTemplate({ isMac, isDev }) {
  const viewSubmenu = [
    ...(isDev
      ? [
          { role: "reload" },
          { role: "forceReload" },
          // Linux/Windows: F12, not the default Ctrl+Shift+I — the renderer
          // owns ⌃⇧I ("bring inside the frame", keyboard.ts) on every
          // platform, and a dev-only menu accelerator would shadow it. macOS
          // keeps its ⌥⌘I default (no conflict).
          isMac ? { role: "toggleDevTools" } : { role: "toggleDevTools", accelerator: "F12" },
          { type: "separator" },
        ]
      : []),
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (!isMac) {
    return isDev ? [{ label: "View", submenu: viewSubmenu }] : null;
  }
  return [
    { role: "appMenu" },
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];
}

module.exports = { createFlushCoordinator, appMenuTemplate };
