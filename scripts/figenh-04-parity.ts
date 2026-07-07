#!/usr/bin/env -S npx tsx
// Feature 4 — smart-duplicate AI parity: flux-core duplicateElements (+ CLI) stamps
// an even array with fresh independent ids; the live bridge duplicate matches + is
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
import type { Element, Project } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const near = (a: number, b: number, t = 0.01) => Math.abs(a - b) <= t;
const rect = (id: string, x: number): Element =>
  ({ type: "rect", id, x, y: 100, width: 60, height: 40, rotation: 0, fill: "#888", stroke: "#222", strokeWidth: 2, cornerRadius: 0 }) as Element;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f4-"));
try {
  await core.scaffold(root, { title: "F4" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });
  {
    const { project, index } = await core.loadFigModel(root);
    ops.addElement(project, figureId, rect("m", 100));
    await core.saveFigModel(root, project, index, "seed");
  }

  // flux-core count:4 → an even row at +50 with unique ids
  const r = await core.duplicateElements(root, figureId, ["m"], { dx: 50, dy: 0, count: 4 });
  {
    const { project } = await core.loadFigModel(root);
    const els = project.figures.find((ff) => ff.id === figureId)!.elements;
    assert(els.length === 5, `count:4 → 5 elements total (${els.length})`);
    const xs = els.map((e) => e.x).sort((a, b) => a - b);
    const diffs = xs.slice(1).map((x, i) => x - xs[i]);
    assert(diffs.every((d) => near(d, 50)), `even +50 row (${xs.join(",")})`);
    assert(new Set(els.map((e) => e.id)).size === 5, "all element ids unique");
    assert(r.ids.length === 1 && r.ids.every((id) => els.some((e) => e.id === id)), "returns the last stamp's ids");
  }

  // CLI duplicate
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "duplicate", figureId, "m", "--dx", "0", "--dy", "70", "--count", "2", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const { project } = await core.loadFigModel(root);
    assert(project.figures.find((ff) => ff.id === figureId)!.elements.length === 7, `CLI duplicate count:2 → 7 total (${project.figures.find((ff) => ff.id === figureId)!.elements.length})`);
  } catch (e) {
    assert(false, `CLI duplicate failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // live bridge duplicate — matches + undoable
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 300, background: "#fff", elements: [rect("b1", 40)] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  store.selection.set(new Set(["b1"]));
  const rb = (await dispatchCommand({ type: "duplicate", ids: ["b1"], dx: 24, dy: 0, count: 3 })) as { ids: string[] };
  const els = () => get(store.project).figures[0].elements;
  assert(els().length === 4, `bridge duplicate count:3 → 4 total (${els().length})`);
  assert(get(store.selection).size === rb.ids.length && rb.ids.every((id) => get(store.selection).has(id)), "bridge selects the new stamp");
  store.undo();
  assert(els().length === 1, "bridge duplicate undoable (one entry)");

  console.log(fails === 0 ? "\nF4 PARITY ALL PASS" : `\nF4 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
