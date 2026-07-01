#!/usr/bin/env -S npx tsx
// Feature 7 — exact-gap distribute AI parity: flux-core distributeFigure(gap),
// the CLI `distribute --gap`, and the live bridge distribute{gap} all reproduce the
// GUI's exact-gap ops.distributePanels; the bridge edit is undoable.
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
  ({ type: "rect", id, x, y: 0, width: 100, height: 60, rotation: 0, fill: "#888", stroke: "#222", strokeWidth: 2, cornerRadius: 0 }) as Element;
const gapsOf = (els: { x: number; width: number }[]) => {
  const s = els.slice().sort((a, b) => a.x - b.x);
  return s.slice(1).map((e, i) => e.x - (s[i].x + s[i].width));
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f7-"));
try {
  await core.scaffold(root, { title: "F7" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });
  {
    const { project, index } = await core.loadFigModel(root);
    ops.addElement(project, figureId, rect("a", 0));
    ops.addElement(project, figureId, rect("b", 190));
    ops.addElement(project, figureId, rect("c", 500));
    await core.saveFigModel(root, project, index, "seed");
  }

  // flux-core exact-gap
  await core.distributeFigure(root, figureId, "h", 24);
  {
    const { project } = await core.loadFigModel(root);
    const els = project.figures[0].elements as { x: number; width: number }[];
    const g = gapsOf(els);
    assert(g.every((x) => near(x, 24)), `flux-core distribute gap:24 → gutters ${g.join(",")}`);
  }

  // CLI distribute --gap 40
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "distribute", figureId, "--gap", "40", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const { project } = await core.loadFigModel(root);
    const g = gapsOf(project.figures[0].elements as { x: number; width: number }[]);
    assert(g.every((x) => near(x, 40)), `CLI distribute --gap 40 → gutters ${g.join(",")}`);
  } catch (e) {
    assert(false, `CLI distribute failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // live bridge distribute{gap} — equals GUI + undoable
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 300, background: "#fff", elements: [rect("a", 0), rect("b", 170), rect("c", 460)] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  store.selection.set(new Set(["a", "b", "c"]));
  await dispatchCommand({ type: "distribute", axis: "h", gap: 24 });
  const cur = () => get(store.project).figures[0].elements as { x: number; width: number }[];
  assert(gapsOf(cur()).every((x) => near(x, 24)), "bridge distribute{gap:24} → all gutters 24");
  store.undo();
  assert(!gapsOf(cur()).every((x) => near(x, 24)), "bridge distribute{gap} undoable");

  console.log(fails === 0 ? "\nF7 PARITY ALL PASS" : `\nF7 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
