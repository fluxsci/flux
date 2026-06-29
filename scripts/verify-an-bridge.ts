#!/usr/bin/env -S npx tsx
// WS4 — the live agent context bridge, end-to-end minus the Electron IPC relay:
// the real loopback server (bridgeServer.cjs) is wired to the real renderer logic
// (appContext + commands over the live Figure store) and driven by the real client
// (flux-core/liveClient) over HTTP. Proves: token auth, GET /context reflects the
// store, POST /dispatch applies the SAME undoable edit a human makes, and teardown.
// Run: npx tsx scripts/verify-an-bridge.ts
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as store from "../src/lib/store";
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
store.embeddedProjectRoot.set(root); // so context.projectRoot resolves

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

  console.log("\nALL LIVE-BRIDGE (WS4) TESTS PASSED");
} finally {
  bridge.stop();
  assert(!(await live.bridgeAvailable(root)), "bridge unavailable after stop (bridge.json removed)");
  await fs.rm(root, { recursive: true, force: true });
}
