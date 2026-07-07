#!/usr/bin/env -S npx tsx
// Feature 5 — proportional-scale AI parity: flux-core scaleElements (+ CLI) scales
// geometry + stroke/corner/font together, and the live bridge scale matches + is
// undoable.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Element, Project, RectElement } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 0.5) => Math.abs(a - b) <= t;
const rect = (id: string): Element =>
  ({ type: "rect", id, x: 100, y: 100, width: 200, height: 100, rotation: 0, fill: "#888", stroke: "#222", strokeWidth: 8, cornerRadius: 16 }) as Element;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f5-"));
try {
  await core.scaffold(root, { title: "F5" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });
  {
    const { project, index } = await core.loadFigModel(root);
    ops.addElement(project, figureId, rect("r1"));
    await core.saveFigModel(root, project, index, "seed");
  }

  // flux-core scale 0.5 about bbox centre
  await core.scaleElements(root, ["r1"], 0.5);
  {
    const { project } = await core.loadFigModel(root);
    const r = project.figures.find((ff) => ff.id === figureId)!.elements.find((e) => e.id === "r1") as RectElement;
    assert(near(r.width, 100) && near(r.height, 50) && near(r.strokeWidth, 4) && near(r.cornerRadius, 8), `flux-core scale 0.5 → w100 h50 sw4 r8 (w=${r.width} sw=${r.strokeWidth} r=${r.cornerRadius})`);
    // scaled about centre → centre unchanged (x shifts inward by quarter width)
    assert(near(r.x, 150) && near(r.y, 125), `scaled about bbox centre (x=${r.x}, y=${r.y})`);
  }

  // CLI scale --factor 2 (back up)
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "scale", "r1", "--factor", "2", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const { project } = await core.loadFigModel(root);
    const r = project.figures.find((ff) => ff.id === figureId)!.elements.find((e) => e.id === "r1") as RectElement;
    assert(near(r.width, 200) && near(r.strokeWidth, 8), `CLI scale 2× restored (w=${r.width} sw=${r.strokeWidth})`);
  } catch (e) {
    assert(false, `CLI scale failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // live bridge scale — matches + undoable
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 400, background: "#fff", elements: [rect("b1")] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  store.selection.set(new Set(["b1"]));
  await dispatchCommand({ type: "scale", ids: ["b1"], factor: 0.5 });
  const b1 = () => get(store.project).figures[0].elements[0] as RectElement;
  assert(near(b1().width, 100) && near(b1().strokeWidth, 4), `bridge scale 0.5 → w100 sw4 (w=${b1().width} sw=${b1().strokeWidth})`);
  store.undo();
  assert(near(b1().width, 200) && near(b1().strokeWidth, 8), "bridge scale undoable");

  console.log(fails === 0 ? "\nF5 PARITY ALL PASS" : `\nF5 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
