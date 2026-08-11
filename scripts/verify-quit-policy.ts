// Quit-wedge R2/R3 (notes/aug_10_deferred_updates/quit_wedge_and_silent_launch.md):
// the app must quit when the last APP window closes, regardless of hidden
// utility windows (proxy-capture, print) still being open — a hidden
// BrowserWindow counts for Electron's `window-all-closed`, whose only teardown
// path for those windows runs from `before-quit`, a closed loop that left a
// windowless main process holding the single-instance lock forever.
//
// The decision lives Electron-free in electron/appLifecycle.cjs
// (createAppWindowPolicy) exactly so this pure gate can drive it with fake
// window records. The invariant under test: *a window the user cannot see must
// never keep the app alive.*

import { createRequire } from "node:module";
import { harness } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const { createAppWindowPolicy } = require("../electron/appLifecycle.cjs");

const h = harness("verify-quit-policy");

interface Policy {
  register(win: object): () => void;
  noteClosed(opts?: { quitting?: boolean }): boolean;
  count(): number;
}
const make = (isMac: boolean): { policy: Policy; quits: () => number } => {
  let quits = 0;
  const policy = (createAppWindowPolicy as (o: { isMac: boolean; quit: () => void }) => Policy)({
    isMac,
    quit: () => quits++,
  });
  return { policy, quits: () => quits };
};

h.section("the wedge scenario: hidden utility windows never block quit (linux/win32)");
{
  const { policy, quits } = make(false);
  const appWin = {};
  // The proxy-capture and print windows are simply NEVER registered — that is
  // the whole mechanism. Model them existing by not touching the policy.
  const unregister = policy.register(appWin);
  h.eq(policy.count(), 1, "one app window registered");
  unregister();
  const quit = policy.noteClosed({ quitting: false });
  h.ok(quit, "last app window's close triggers the quit");
  h.eq(quits(), 1, "quit() fired exactly once — with hidden windows conceptually still open");
}

h.section("a second app window keeps the app alive");
{
  const { policy, quits } = make(false);
  const unregA = policy.register({});
  policy.register({});
  unregA();
  h.ok(!policy.noteClosed({ quitting: false }), "closing one of two app windows does not quit");
  h.eq(quits(), 0, "quit() not fired while an app window remains");
}

h.section("macOS: closing the last window never quits (dock keeps the app)");
{
  const { policy, quits } = make(true);
  const unregister = policy.register({});
  unregister();
  h.ok(!policy.noteClosed({ quitting: false }), "mac: last close returns false");
  h.eq(quits(), 0, "mac: quit() not fired");
}

h.section("an in-flight quit is not re-issued");
{
  const { policy, quits } = make(false);
  const unregister = policy.register({});
  unregister();
  h.ok(!policy.noteClosed({ quitting: true }), "quitting=true suppresses the re-issue");
  h.eq(quits(), 0, "quit() not double-fired during teardown");
}

h.section("unregister is idempotent and scoped to its own window");
{
  const { policy } = make(false);
  const unregA = policy.register({});
  policy.register({});
  unregA();
  unregA(); // double-dispose must not touch the other window
  h.eq(policy.count(), 1, "double unregister leaves the other window tracked");
}

await h.done();
