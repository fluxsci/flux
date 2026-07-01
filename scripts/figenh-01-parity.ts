#!/usr/bin/env -S npx tsx
// Feature 1 — pen/vector AI parity: a path authored via flux-core (+ CLI) and the
// live bridge matches the GUI's ops.addPath/updatePath, renders through the same
// figureToSvg → PNG, and the bridge edits are undoable. "No capability is GUI-only."
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import { nodesToPath } from "../src/lib/path";
import type { PathElement, Project, VectorNode } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}

const NODES: VectorNode[] = [
  { x: 0, y: 0, type: "corner" },
  { x: 80, y: 0, type: "smooth", hIn: { dx: -20, dy: 0 }, hOut: { dx: 20, dy: 0 } },
  { x: 120, y: 60, type: "corner" },
];

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f1-"));
try {
  await core.scaffold(root, { title: "F1" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });

  // --- flux-core addPath ---
  const { id } = await core.addPath(root, figureId, { nodes: NODES, stroke: "#e00", strokeWidth: 3 });
  {
    const { project } = await core.loadFigModel(root);
    const p = project.figures.find((f) => f.id === figureId)!.elements.find((e) => e.id === id) as PathElement;
    assert(p && p.type === "path", "flux-core add-path created a path element");
    assert(p.nodes?.length === 3 && /C /.test(p.d), `path has 3 nodes + a cubic (d="${p.d}")`);
    assert(p.width > 0 && p.height > 0, `bbox fitted (${p.width}x${p.height})`);
    // GUI-parity: identical nodes → identical d (both go through ops.addPath/refit)
    const guiProj: Project = { version: 1, name: "t", canvases: [{ id: "c", name: "C" }], figures: [{ id: "g", name: "F", canvasId: "c", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }], assets: [], palette: [] };
    const gid = ops.addPath(guiProj, "g", { nodes: NODES, stroke: "#e00", strokeWidth: 3 })!;
    const gp = guiProj.figures[0].elements[0] as PathElement;
    assert(gp.d === p.d, "flux-core d ≡ GUI ops.addPath d (same node list)");
    void gid;
  }

  // --- flux-core editPath: close it ---
  await core.editPath(root, id, { closed: true });
  {
    const { project } = await core.loadFigModel(root);
    const p = project.figures[0].elements.find((e) => e.id === id) as PathElement;
    assert(p.closed === true && p.d.trim().endsWith("Z"), "edit-path close → closed + d ends with Z");
  }

  // --- CLI binary: add a second path ---
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "add-path", figureId, "--nodes", JSON.stringify(NODES), "--stroke", "#07c", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const { project } = await core.loadFigModel(root);
    const paths = project.figures[0].elements.filter((e) => e.type === "path");
    assert(paths.length === 2, `CLI add-path created a 2nd path (${paths.length} total)`);
  } catch (e) {
    assert(false, `CLI add-path failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // --- render: the path flows through figureToSvg → PNG (same as GUI export) ---
  const svg = await core.renderFigureSvg(root, figureId);
  assert(/<path/.test(svg) && svg.includes("#e00"), "rendered SVG contains the path (stroke #e00)");
  const png = await core.renderFigurePng(root, figureId, 2);
  const isPng = png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  assert(isPng, `render-figure --png produced a real PNG (${png.length} bytes)`);
  await fs.writeFile(path.join(root, "figp.png"), png);

  // --- live bridge: add_path → edit_path → undo (all undoable, GUI-identical) ---
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  const r = (await dispatchCommand({ type: "add_path", figureId: "f1", nodes: NODES, stroke: "#0a0" })) as { id: string };
  const els = () => get(store.project).figures[0].elements;
  assert(els().length === 1 && els()[0].type === "path", "bridge add_path created a path");
  assert(get(store.selection).has(r.id), "bridge add_path selected the new path");
  const bd = (els()[0] as PathElement).d;
  assert(bd === nodesToPath((els()[0] as PathElement).nodes!, false), "bridge path d matches its nodes");
  await dispatchCommand({ type: "edit_path", id: r.id, closed: true });
  assert((els()[0] as PathElement).closed === true, "bridge edit_path closed the path");
  store.undo();
  assert((els()[0] as PathElement).closed === false, "undo restored the open path");
  store.undo();
  assert(els().length === 0, "second undo removed the added path");

  console.log(fails === 0 ? "\nF1 PARITY ALL PASS" : `\nF1 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
