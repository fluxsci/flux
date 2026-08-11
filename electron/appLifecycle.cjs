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
 * The quit decision (quit-wedge R2, 2026-08-11). The invariant this encodes:
 * **a window the user cannot see must never keep the app alive.** Electron's
 * `window-all-closed` counts every BrowserWindow — including the hidden
 * proxy-capture and print utility windows — so a surviving hidden window used
 * to leave a windowless main process holding the single-instance lock forever
 * (notes/aug_10_deferred_updates/quit_wedge_and_silent_launch.md). Instead,
 * APP windows register here explicitly (utility windows never do), and the
 * last app window's close triggers the quit directly on non-mac platforms.
 * `window-all-closed` stays registered in main.cjs as a belt.
 *
 * Electron-free on purpose (register() takes any object identity) so the pure
 * tier can drive it: scripts/verify-quit-policy.ts.
 */
function createAppWindowPolicy({ isMac, quit }) {
  const appWindows = new Set();
  return {
    /** Track an APP window. Returns the unregister fn — call it from the
     *  window's `closed` handler BEFORE noteClosed(). */
    register(win) {
      appWindows.add(win);
      return () => appWindows.delete(win);
    },
    /** Call after an app window closed + unregistered. Quits (and returns
     *  true) when it was the last one, off-mac, and no quit is already under
     *  way — regardless of any hidden utility windows still open. */
    noteClosed({ quitting = false } = {}) {
      if (appWindows.size > 0 || isMac || quitting) return false;
      quit();
      return true;
    },
    count: () => appWindows.size,
  };
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
 *   • `onNewWindow` (multi-window, 2026-08-11): macOS gets File → New Window
 *     (Cmd+Shift+N — Cmd+N stays free for a future New Project). Linux/Windows
 *     have no production menu; the renderer owns Ctrl+Shift+N there.
 */
function appMenuTemplate({ isMac, isDev, onNewWindow }) {
  const viewSubmenu = [
    ...(isDev
      ? [
          // Ctrl+F5, not the default CmdOrCtrl+R — the renderer owns ⌃R (the
          // Figure Namer, keyboard.ts) on every platform, and a dev-only menu
          // accelerator would shadow it AND silently wipe unsaved renderer
          // state (same reasoning as F12 for DevTools below).
          { role: "reload", accelerator: "Ctrl+F5" },
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
    ...(onNewWindow
      ? [
          {
            label: "File",
            submenu: [
              { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: onNewWindow },
            ],
          },
        ]
      : []),
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];
}

module.exports = { createFlushCoordinator, createAppWindowPolicy, appMenuTemplate };
