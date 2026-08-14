#!/usr/bin/env -S npx tsx
// The external-reload contract (W10 live reload + the divergence banner's
// "Reload theirs"): an agent/CLI edit to fig/ reloads IN PLACE — the user's
// active canvas/figure/selection survive wherever their ids do, and the swap
// lands as ONE undo entry so Ctrl+Z restores the exact pre-agent state (with
// the pre-reload history intact BENEATH it). Initial loads keep the original
// semantics: history reset, first-canvas view. Pins store.loadProject's
// `reload` opts (src/lib/store.ts) — the fix for the canvas-jump +
// dead-Ctrl+Z pair reported 2026-08-14.
// Run: npx tsx scripts/verify-fig-reload-preserve.ts
import { get } from "svelte/store";
import * as store from "../src/lib/store";
import type { Project, Figure, Element } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// Two canvases, one figure each, one rect each — enough identity to tell
// "preserved" from "reset to first". `fill` is the agent-visible payload.
function makeProject(fill: string, opts: { dropC2?: boolean } = {}): Project {
  const el = (id: string): Element =>
    ({
      type: "rect",
      id,
      x: 10,
      y: 10,
      width: 40,
      height: 30,
      rotation: 0,
      fill,
      stroke: "#222222",
      strokeWidth: 1,
      cornerRadius: 0,
    }) as Element;
  const fig = (id: string, canvasId: string, name: string, elId: string): Figure =>
    ({
      id,
      name,
      canvasId,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      background: "#ffffff",
      elements: [el(elId)],
    }) as Figure;
  const canvases = [{ id: "c1", name: "Canvas 1" }];
  const figures = [fig("f1", "c1", "Figure 1", "e1")];
  if (!opts.dropC2) {
    canvases.push({ id: "c2", name: "Canvas 2" });
    figures.push(fig("f2", "c2", "Figure 2", "e2"));
  }
  return { version: 2, name: "t", canvases, figures, assets: [], palette: [] } as Project;
}

const fillOf = (elId: string) =>
  (get(store.project)
    .figures.flatMap((f) => f.elements)
    .find((e) => e.id === elId) as { fill?: string } | undefined)?.fill;

// --- 1. Initial load: original semantics ------------------------------------
store.loadProject(makeProject("#aaaaaa"), null);
assert(get(store.activeCanvasId) === "c1", "initial load lands on the first canvas");
store.undo();
assert(get(store.project).name === "t" && get(store.dirty) === false, "initial load reset history (undo is a no-op, stays clean)");

// --- 2. User works on canvas 2 ----------------------------------------------
store.setActiveCanvas("c2");
store.selectOnly("e2");
store.partSelection.set({ elementId: "e2", partId: "control.line" });
store.captionOpen.set(true);
store.commit((p) => {
  p.figures.find((f) => f.id === "f2")!.name = "Renamed by user";
});

// --- 3. Agent reload: view survives, change lands, editor stays clean --------
store.loadProject(makeProject("#00ff00"), null, { reload: true });
assert(get(store.activeCanvasId) === "c2", "reload preserves the active canvas");
assert(get(store.activeFigureId) === "f2", "reload preserves the active figure");
assert(get(store.selection).has("e2"), "reload preserves the selection (surviving ids)");
assert(get(store.partSelection)?.elementId === "e2", "reload preserves the part selection");
assert(get(store.captionOpen) === true, "reload keeps the caption editor open (figure survived)");
assert(fillOf("e2") === "#00ff00", "the agent's change is live after the reload");
assert(get(store.dirty) === false, "landing an external change leaves the editor clean");

// --- 4. Ctrl+Z restores the pre-agent state; deeper history intact -----------
store.undo();
assert(fillOf("e2") === "#aaaaaa", "undo restores the pre-agent state");
assert(
  get(store.project).figures.find((f) => f.id === "f2")!.name === "Renamed by user",
  "…including the user's own last edit",
);
assert(get(store.dirty) === true, "reverting the agent dirties (the revert must save)");
store.undo();
assert(
  get(store.project).figures.find((f) => f.id === "f2")!.name === "Figure 2",
  "pre-reload history survives BENEATH the reload entry",
);
store.redo();
store.redo();
assert(fillOf("e2") === "#00ff00", "redo re-applies up through the agent's state");

// --- 5. Vanished canvas: graceful fallback, no dangling ids ------------------
store.loadProject(makeProject("#0000ff", { dropC2: true }), null, { reload: true });
assert(get(store.activeCanvasId) === "c1", "a deleted active canvas falls back to the first");
assert(get(store.selection).size === 0, "selection ids that vanished are dropped");
assert(get(store.partSelection) === null, "part selection dropped with its element");
assert(get(store.captionOpen) === false, "caption editor closes when its figure is gone");
store.undo();
assert(get(store.selection).size === 0 && fillOf("e2") === "#00ff00", "even the fallback reload is one undo step back");

console.log("\nALL FIG-RELOAD-PRESERVE TESTS PASSED");
