import { mount } from "svelte";
import "./styles/tokens.css";
import "./styles/cursors.css";
import "./styles/fonts.css";
import "./app.css";
import Shell from "./shell/Shell.svelte";

// Dev-only headless-test handles (§1.4). Dynamic imports keep them out of
// production builds. See src/lib/dev/devHandle.ts and src/lib/project/memBridge.ts.
if (import.meta.env.DEV) {
  void import("./lib/dev/devHandle").then((m) => m.installDevHandle());
}

function mountShell() {
  const app = mount(Shell, {
    target: document.getElementById("app")!,
    intro: true,
  });

  // Live agent context bridge (WS4): no-ops unless running under Electron with the
  // bridge preload. Lets an external agent read the live UI state and act on the
  // human's current selection. Dynamic import keeps it off the critical path.
  void import("./lib/bridge/install").then((m) => m.installBridge());
  // Letter outlines for text ↔ shape Becomes: system fonts over the IPC (none
  // outside Electron — letters then land as glyph boxes). Off the critical path.
  void Promise.all([import("./lib/slide/player/glyphProvider"), import("./lib/text/glyphFontsGui")])
    .then(([provider, gui]) => provider.registerGlyphFonts(gui.guiGlyphFontLoader()));
  return app;
}

async function mountDemo() {
  const [{ installDemoFixture }, { openProjectAt }] = await Promise.all([
    import("./lib/project/memBridge"),
    import("./shell/shellStore"),
  ]);
  // Match Electron's preload order: shell consumers must see the bridge on their
  // first mount, including capability probes and one-time event subscriptions.
  const root = await installDemoFixture();
  const app = mountShell();
  await openProjectAt(root);
  return app;
}

// `?fixture=demo` supplies the in-memory project only on the dev server.
const app = import.meta.env.DEV && new URLSearchParams(location.search).has("fixture") ? mountDemo() : mountShell();
export default app;
