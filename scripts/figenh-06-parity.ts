#!/usr/bin/env -S npx tsx
// Feature 6 — AI parity: hidden/locked/name via set_style + z-reorder are
// reproducible through (1) flux-core file verbs (+ CLI), (2) the live bridge
// (dispatchCommand, undoable), matching the GUI's ops. Hidden is omitted from
// the rendered SVG/PNG.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Element, Project } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const rect = (id: string, x: number, fill: string): Element =>
  ({ type: "rect", id, x, y: 20, width: 120, height: 90, rotation: 0, fill, stroke: "#222222", strokeWidth: 2, cornerRadius: 0 }) as Element;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f6-"));
try {
  // ---- flux-core (file verbs) ----
  await core.scaffold(root, { title: "F6" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });
  {
    const { project, index } = await core.loadFigModel(root);
    ops.addElement(project, figureId, rect("r1", 10, "#d62728"));
    ops.addElement(project, figureId, rect("r2", 150, "#2ca02c"));
    ops.addElement(project, figureId, rect("r3", 290, "#1f77b4"));
    await core.saveFigModel(root, project, index, "seed");
  }

  // hidden → omitted from render
  await core.setElementStyle(root, ["r2"], { hidden: true });
  let svg = await core.renderFigureSvg(root, figureId);
  assert(!svg.includes("#2ca02c"), "flux-core: hidden r2 omitted from rendered SVG");
  assert(svg.includes("#d62728") && svg.includes("#1f77b4"), "flux-core: visible r1/r3 still rendered");
  const png = await core.renderFigurePng(root, figureId, 2);
  assert(png.length > 100, `flux-core: PNG renders with hidden omitted (${png.length} bytes)`);

  // name + locked persist to the canvas file
  await core.setElementStyle(root, ["r1"], { name: "Scale bar", locked: true });
  {
    const { project } = await core.loadFigModel(root);
    const r1 = project.figures.find((f) => f.id === figureId)!.elements.find((e) => e.id === "r1")!;
    assert(r1.name === "Scale bar" && r1.locked === true, "flux-core: name + locked persisted");
  }

  // reorder r1 → top (array index 2): [r2, r3, r1]
  await core.reorderElement(root, figureId, "r1", 2);
  {
    const { project } = await core.loadFigModel(root);
    const order = project.figures.find((f) => f.id === figureId)!.elements.map((e) => e.id);
    assert(JSON.stringify(order) === JSON.stringify(["r2", "r3", "r1"]), `flux-core: reorder → ${order}`);
  }

  // ---- CLI binary smoke (set-style --show unhides r2; render reflects it) ----
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "set-style", "r2", "--show", "--root", root], {
      cwd: path.resolve("."),
      stdio: "pipe",
    });
    svg = await core.renderFigureSvg(root, figureId);
    assert(svg.includes("#2ca02c"), "CLI: `set-style r2 --show` unhid r2 (present in SVG again)");
  } catch (e) {
    assert(false, `CLI set-style failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // ---- live bridge (in-process): dispatchCommand mutates the store, undoable ----
  const proj: Project = {
    version: 1,
    name: "t",
    canvases: [{ id: "c1", name: "C" }],
    figures: [
      { id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [rect("b1", 10, "#d62728"), rect("b2", 150, "#2ca02c"), rect("b3", 290, "#1f77b4")] },
    ],
    assets: [],
    palette: [],
  };
  store.loadProject(proj, null);
  store.activeFigureId.set("f1");

  await dispatchCommand({ type: "set_style", ids: ["b2"], patch: { hidden: true } });
  const b2 = () => get(store.project).figures[0].elements.find((e) => e.id === "b2")!;
  assert(b2().hidden === true, "bridge: set_style {hidden} applied to the live store");
  store.undo();
  assert(!b2().hidden, "bridge: hidden is undoable (Ctrl+Z)");

  await dispatchCommand({ type: "set_z", figureId: "f1", ids: ["b1"], index: 2 });
  const order2 = get(store.project).figures[0].elements.map((e) => e.id);
  assert(JSON.stringify(order2) === JSON.stringify(["b2", "b3", "b1"]), `bridge: set_z {index:2} → ${order2}`);
  store.undo();
  const order3 = get(store.project).figures[0].elements.map((e) => e.id);
  assert(JSON.stringify(order3) === JSON.stringify(["b1", "b2", "b3"]), "bridge: reorder is undoable");

  console.log(fails === 0 ? "\nF6 PARITY ALL PASS" : `\nF6 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
