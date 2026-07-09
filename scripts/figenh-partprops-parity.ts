#!/usr/bin/env -S npx tsx
// figure-v1 Phase 2 — agent parity for part properties: the bridge-level
// `restyle_part` verb carries the NEW override keys (dx/dy translation,
// fontStyle, textDecoration) through ops.setPartOverride into the live model,
// exactly like the GUI's part fields / part-move / nudge do. The verb passes
// open patches, so no bridge edit was needed — this pins that contract.
//
//  Run: npx tsx scripts/figenh-partprops-parity.ts
import { get } from "svelte/store";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Project, SemanticPlotElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const plot: SemanticPlotElement = {
  type: "plot",
  id: "p1",
  x: 10,
  y: 10,
  width: 480,
  height: 360,
  rotation: 0,
  assetId: "a1",
  overrides: {},
};

const proj: Project = {
  version: 1,
  name: "t",
  canvases: [{ id: "c1", name: "C" }],
  figures: [
    { id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 600, background: "#fff", elements: [plot] },
  ],
  assets: [],
  palette: [],
};
store.loadProject(proj, null);
store.activeFigureId.set("f1");

const ovOf = (partId: string) => {
  const p = get(store.project);
  const el = p.figures[0].elements.find((e) => e.id === "p1") as SemanticPlotElement;
  return el.overrides?.[partId];
};

// explicit ids + the full new-key patch
await dispatchCommand({
  type: "restyle_part",
  elementId: "p1",
  partId: "axis.x.ticklabel.1",
  patch: { dx: 4, dy: -2, fontStyle: "italic", textDecoration: "underline" },
});
let o = ovOf("axis.x.ticklabel.1");
assert(o?.dx === 4 && o?.dy === -2, `restyle_part persists dx/dy (${o?.dx}, ${o?.dy})`);
assert(o?.fontStyle === "italic", "restyle_part persists fontStyle");
assert(o?.textDecoration === "underline", "restyle_part persists textDecoration");

// merge semantics: a later patch keeps earlier keys
await dispatchCommand({ type: "restyle_part", elementId: "p1", partId: "axis.x.ticklabel.1", patch: { fill: "#cc0000" } });
o = ovOf("axis.x.ticklabel.1");
assert(o?.fill === "#cc0000" && o?.dx === 4 && o?.fontStyle === "italic", "patches MERGE per part (fill added, dx/fontStyle kept)");

// partSelection-defaulted targeting ("restyle what I drilled into")
store.partSelection.set({ elementId: "p1", partId: "ctl.line" });
await dispatchCommand({ type: "restyle_part", patch: { dx: 1.5, dy: 0.5 } });
o = ovOf("ctl.line");
assert(o?.dx === 1.5 && o?.dy === 0.5, "restyle_part defaults to the drilled part selection");
store.partSelection.set(null);

// undoable, one entry per dispatch
store.undo();
assert(ovOf("ctl.line") === undefined, "one undo reverts the last restyle_part dispatch");
store.undo();
o = ovOf("axis.x.ticklabel.1");
assert(o?.fill === undefined && o?.dx === 4, "next undo peels the merge patch, keeping the first");
store.undo();
assert(ovOf("axis.x.ticklabel.1") === undefined, "final undo reverts to a pristine plot");

// hidden toggles ride the same verb (the 'x' hotkey's agent twin)
await dispatchCommand({ type: "restyle_part", elementId: "p1", partId: "ctl", patch: { hidden: true } });
assert(ovOf("ctl")?.hidden === true, "restyle_part {hidden} works (agent twin of the 'x' hotkey)");

console.log(fails === 0 ? "\nfigenh-partprops-parity: ALL OK" : `\nfigenh-partprops-parity: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
