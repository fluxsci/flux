import { mount } from "svelte";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./app.css";
import Shell from "./shell/Shell.svelte";

// Dev-only headless-test handles (§1.4). Dynamic imports keep them out of
// production builds. See src/lib/dev/devHandle.ts and src/lib/project/memBridge.ts.
if (import.meta.env.DEV) {
  void import("./lib/dev/devHandle").then((m) => m.installDevHandle());
  // `?fixture=demo` backs window.fig with an in-memory project (manuscript with
  // @fig/@cite, a figure with panels, a library.bib) so the full app runs on the
  // dev server without Electron.
  if (new URLSearchParams(location.search).has("fixture")) {
    void (async () => {
      const [{ installDemoFixture }, { openProjectAt }] = await Promise.all([
        import("./lib/project/memBridge"),
        import("./shell/shellStore"),
      ]);
      await openProjectAt(await installDemoFixture());
    })();
  }
}

const app = mount(Shell, {
  target: document.getElementById("app")!,
  intro: true,
});

// Live agent context bridge (WS4): no-ops unless running under Electron with the
// bridge preload. Lets an external agent read the live UI state and act on the
// human's current selection. Dynamic import keeps it off the critical path.
void import("./lib/bridge/install").then((m) => m.installBridge());

export default app;
