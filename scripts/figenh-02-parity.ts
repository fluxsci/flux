#!/usr/bin/env -S npx tsx
// Feature 2 — rotate AI parity: rotate via flux-core (+ CLI) and the live bridge
// matches the GUI's ops.rotateElements; single-element rotate ≡ set_style{rotation};
// group members orbit the pivot; the bridge edit is undoable.
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
const rect = (id: string, x: number, y: number): Element =>
  ({ type: "rect", id, x, y, width: 100, height: 80, rotation: 0, fill: "#888", stroke: "#222", strokeWidth: 2, cornerRadius: 0 }) as Element;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f2-"));
try {
  await core.scaffold(root, { title: "F2" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });
  {
    const { project, index } = await core.loadFigModel(root);
    ops.addElement(project, figureId, rect("r1", 20, 20));
    ops.addElement(project, figureId, rect("r2", 200, 20));
    ops.addElement(project, figureId, rect("r3", 380, 200));
    await core.saveFigModel(root, project, index, "seed");
  }

  // single-element rotate ≡ set_style{rotation}
  await core.rotateElements(root, ["r1"], 45);
  {
    const { project } = await core.loadFigModel(root);
    const r1 = project.figures.find((f) => f.id === figureId)!.elements.find((e) => e.id === "r1")!;
    assert(near(r1.rotation, 45) && near(r1.x, 20) && near(r1.y, 20), `flux-core rotate single → 45° in place (rot=${r1.rotation}, x=${r1.x})`);
  }

  // group rotate: members orbit + each rotation increments
  const beforeG = await core.loadFigModel(root).then((m) => m.project.figures[0].elements.map((e) => ({ id: e.id, x: e.x, y: e.y, r: e.rotation })));
  await core.rotateElements(root, ["r1", "r2", "r3"], 90);
  {
    const { project } = await core.loadFigModel(root);
    const els = project.figures[0].elements;
    const eachInc = els.every((e) => { const b = beforeG.find((z) => z.id === e.id)!; return near(e.rotation, b.r + 90); });
    const orbited = els.some((e) => { const b = beforeG.find((z) => z.id === e.id)!; return Math.abs(e.x - b.x) > 1 || Math.abs(e.y - b.y) > 1; });
    assert(eachInc, "flux-core group rotate: every member rotation += 90");
    assert(orbited, "flux-core group rotate: members orbit the pivot");
  }

  // CLI binary: rotate r2 by 30° more
  const before2 = await core.loadFigModel(root).then((m) => m.project.figures[0].elements.find((e) => e.id === "r2")!.rotation);
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "rotate", "r2", "--deg", "30", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const after2 = await core.loadFigModel(root).then((m) => m.project.figures[0].elements.find((e) => e.id === "r2")!.rotation);
    assert(near(after2, before2 + 30), `CLI rotate r2 +30 → ${after2}`);
  } catch (e) {
    assert(false, `CLI rotate failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // live bridge: rotate is undoable, and equals set_style for a single element
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements: [rect("b1", 20, 20)] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  store.selectOnly("b1");
  await dispatchCommand({ type: "rotate", deg: 37 });
  const b1 = () => get(store.project).figures[0].elements[0];
  assert(near(b1().rotation, 37), `bridge rotate {deg:37} → ${b1().rotation}`);
  const viaRotate = { x: b1().x, y: b1().y, rotation: b1().rotation };
  store.undo();
  assert(near(b1().rotation, 0), "bridge rotate undoable");
  // set_style{rotation:37} on the same element yields the same model
  await dispatchCommand({ type: "set_style", ids: ["b1"], patch: { rotation: 37 } });
  const viaStyle = { x: b1().x, y: b1().y, rotation: b1().rotation };
  assert(JSON.stringify(viaRotate) === JSON.stringify(viaStyle), "single-element rotate ≡ set_style{rotation}");

  console.log(fails === 0 ? "\nF2 PARITY ALL PASS" : `\nF2 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
