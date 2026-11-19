#!/usr/bin/env -S npx tsx
// WS4 — the live agent context bridge, end-to-end minus the Electron IPC relay:
// the real loopback server (bridgeServer.cjs) is wired to the real renderer logic
// (appContext + commands over the live Figure store) and driven by the real client
// (flux-core/liveClient) over HTTP. Proves: token auth, GET /context reflects the
// store, POST /dispatch applies the SAME undoable edit a human makes, and teardown.
// Run: npx tsx scripts/verify-an-bridge.ts
import { mountFigureCommandFixture } from "./lib/liveEditorFixture";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as store from "../src/lib/store";
import { setFocusedMode } from "../src/shell/paneStore";
import { getAppContext } from "../src/lib/bridge/appContext";
import { dispatchCommand } from "../src/lib/bridge/commands";
import * as live from "../flux-core/liveClient";

const require = createRequire(import.meta.url);
const { startBridge } = require("../electron/bridgeServer.cjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bridge-"));
mountFigureCommandFixture(root);
store.embeddedProjectRoot.set(root); // so context.projectRoot resolves
setFocusedMode("figure"); // AGT-14: surface now reflects the REAL focused mode (default is paper)

// Wire the server to the renderer logic (this is exactly what the Electron IPC
// relay does, minus the process boundary).
const bridge = startBridge({
  root,
  getContext: () => getAppContext(),
  dispatch: (cmd: unknown) => dispatchCommand(cmd as Parameters<typeof dispatchCommand>[0]),
  noteWrite: () => {},
});

try {
  for (let i = 0; i < 50 && !(await live.bridgeAvailable(root)); i++) await sleep(20);
  assert(await live.bridgeAvailable(root), "bridge reachable (health + token)");
  assert(bridge.isRunning(), "monitor reports only a listening, published bridge");

  // GET /context reflects the live store.
  const ctx = (await live.getAppContext(root)) as {
    surface: string;
    projectRoot: string;
    figures: { id: string }[];
    selection: string[];
  };
  assert(ctx.surface === "figure" && ctx.projectRoot === root, "context has surface + projectRoot");
  assert(Array.isArray(ctx.figures) && ctx.figures.length >= 1, "context lists the project's figures");

  // POST /dispatch create_figure → applied to the live store.
  const r = (await live.dispatchCommand(root, { type: "create_figure", id: "agentfig", name: "Agent Figure" })) as {
    figureId: string;
  };
  assert(r.figureId === "agentfig", "dispatch returns the new figure id");
  assert(get(store.project).figures.some((f) => f.id === "agentfig"), "create_figure mutated the live store");

  // The agent's edit is the SAME undoable edit a human makes.
  store.undo();
  assert(!get(store.project).figures.some((f) => f.id === "agentfig"), "agent's create_figure is undoable (Ctrl+Z)");
  store.redo();
  assert(get(store.project).figures.some((f) => f.id === "agentfig"), "and redoable");

  // "Act on what the human has selected": drill into a plot part, then restyle
  // with just a patch (partId/elementId default from the live partSelection).
  store.commit((p) => {
    const f = store.getActiveFigure(p)!;
    f.elements.push({
      type: "plot",
      id: "plotX",
      assetId: "a",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
    } as unknown as (typeof f.elements)[number]);
  });
  store.partSelection.set({ elementId: "plotX", partId: "control.line" });
  await live.dispatchCommand(root, { type: "restyle_part", patch: { stroke: "#1b9e77", strokeWidth: 3 } });
  const el = get(store.project)
    .figures.flatMap((f) => f.elements)
    .find((e) => e.id === "plotX") as { overrides?: Record<string, { stroke?: string }> };
  assert(el.overrides?.["control.line"]?.stroke === "#1b9e77", "restyle_part acted on the live partSelection");

  // Context now reflects a new selection.
  store.selectOnly("plotX");
  const ctx2 = (await live.getAppContext(root)) as { selection: string[]; partSelection: unknown };
  assert(ctx2.selection.includes("plotX"), "context reflects the new selection");

  // W11d (FIG-8): authoring over the bridge — an in-app agent can now CREATE, not
  // just restyle. add_text → flip → set_caption, each the same undoable edit.
  const activeFig = get(store.activeFigureId)!;
  const t = (await live.dispatchCommand(root, { type: "add_text", text: "Bridge label", x: 10, y: 20, fontSize: 24 })) as { id: string };
  const textEl = get(store.project).figures.flatMap((f) => f.elements).find((e) => e.id === t.id) as { type: string; text?: string } | undefined;
  assert(textEl?.type === "text" && textEl.text === "Bridge label", "add_text created a text element with the given text");

  await live.dispatchCommand(root, { type: "flip", ids: [t.id], axis: "h" });
  const flipped = get(store.project).figures.flatMap((f) => f.elements).find((e) => e.id === t.id) as { flipX?: boolean };
  assert(flipped.flipX === true, "flip toggled the element's flipX");

  await live.dispatchCommand(root, { type: "set_caption", figureId: activeFig, text: "A live caption." });
  const capFig = get(store.project).figures.find((f) => f.id === activeFig) as { captions?: Record<string, string> };
  assert(capFig.captions?.__figure__ === "A live caption.", "set_caption wrote Figure.captions.__figure__");

  // Auth: a wrong token is rejected.
  const info = JSON.parse(await fs.readFile(path.join(root, ".meta", "live", "bridge.json"), "utf8"));
  const bad = await fetch(`${info.url}/context`, { headers: { authorization: "Bearer wrong" } });
  assert(bad.status === 401, "wrong token rejected (401)");

  // Unknown commands are refused (the switch is the allow-list).
  let refused = false;
  try {
    await live.dispatchCommand(root, { type: "rm_rf_everything" });
  } catch {
    refused = true;
  }
  assert(refused, "unknown command refused");

  // The descriptor is a real, private file (not written in place through whatever was there).
  const descriptor = await fs.lstat(path.join(root, ".meta", "live", "bridge.json"));
  assert(descriptor.isFile() && (process.platform === "win32" || (descriptor.mode & 0o777) === 0o600), "bridge.json is a regular owner-only file");

  // A project can arrive carrying links where the descriptor goes. Nothing is written through them.
  if (process.platform !== "win32") {
    const stub = { getContext: () => ({}), dispatch: async () => ({}) };
    const settle = async (b: { isRunning(): boolean }, want: boolean) => { for (let i = 0; i < 100 && b.isRunning() !== want; i++) await sleep(20); await sleep(60); };
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bridge-outside-"));
    try {
      // (a) bridge.json itself is a link to a file elsewhere: the link is replaced, the target untouched.
      const linkedFile = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bridge-linkfile-"));
      await fs.mkdir(path.join(linkedFile, ".meta", "live"), { recursive: true });
      await fs.writeFile(path.join(outside, "canary.txt"), "untouched", { mode: 0o644 });
      await fs.symlink(path.join(outside, "canary.txt"), path.join(linkedFile, ".meta", "live", "bridge.json"));
      const b1 = startBridge({ root: linkedFile, ...stub });
      await settle(b1, true);
      const st1 = await fs.lstat(path.join(linkedFile, ".meta", "live", "bridge.json"));
      const canary = await fs.stat(path.join(outside, "canary.txt"));
      assert(b1.isRunning() && st1.isFile() && !st1.isSymbolicLink(), "a pre-planted bridge.json link is replaced by a real file");
      assert((await fs.readFile(path.join(outside, "canary.txt"), "utf8")) === "untouched" && (canary.mode & 0o777) === 0o644, "…and the file it pointed at keeps its contents and its permissions");
      b1.stop();
      await fs.rm(linkedFile, { recursive: true, force: true });

      // (b) .meta/live is a link to a folder elsewhere: no token is written there, the bridge stays unpublished.
      const linkedDir = await fs.mkdtemp(path.join(os.tmpdir(), "flux-bridge-linkdir-"));
      await fs.mkdir(path.join(linkedDir, ".meta"));
      await fs.symlink(outside, path.join(linkedDir, ".meta", "live"));
      const b2 = startBridge({ root: linkedDir, ...stub });
      await settle(b2, true);
      assert(!b2.isRunning() && (await fs.readdir(outside)).join() === "canary.txt", "a linked .meta/live gets no token; the bridge is not published");
      b2.stop();
      assert((await fs.readdir(outside)).join() === "canary.txt", "stopping an unpublished bridge removes nothing through the link");
      await fs.rm(linkedDir, { recursive: true, force: true });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  }

  console.log("\nALL LIVE-BRIDGE (WS4) TESTS PASSED");
} finally {
  bridge.stop();
  assert(!bridge.isRunning(), "monitor clears bridge status immediately on stop");
  assert(!(await live.bridgeAvailable(root)), "bridge unavailable after stop (bridge.json removed)");
  await fs.rm(root, { recursive: true, force: true });
}
