#!/usr/bin/env -S npx tsx
// Feature 11 — guides AI parity: flux-core setGuides (+ CLI) writes guides that
// PERSIST in the on-disk model, and the live bridge set_guides matches + is
// undoable. (Rulers/grid/pixel-snap are GUI/Settings — no agent analog.)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { get } from "svelte/store";
import * as core from "../flux-core/index";
import * as store from "../src/lib/store";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Project } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else { fails++; console.error("  FAIL:", msg); }
}
const eq = (a: number[] | undefined, b: number[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-f11-"));
try {
  await core.scaffold(root, { title: "F11" });
  const { figureId } = await core.createFigure(root, { id: "figp", name: "P" });

  // flux-core setGuides + persistence
  await core.setGuides(root, figureId, { x: [408, 100], y: [50] });
  {
    const { project } = await core.loadFigModel(root);
    const g = project.figures.find((f) => f.id === figureId)!.guides;
    assert(g && eq(g.x, [100, 408]) && eq(g.y, [50]), `flux-core set-guides persists sorted (x=${JSON.stringify(g?.x)}, y=${JSON.stringify(g?.y)})`);
  }
  // reload again from disk (fresh) to prove it round-trips through project.json
  {
    const { project } = await core.loadFigModel(root);
    assert(project.figures[0].guides?.x?.includes(408), "guide x=408 survives save/load");
  }

  // CLI set-guides
  try {
    execFileSync("npx", ["tsx", "flux-cli.ts", "set-guides", figureId, "--x", "200,600", "--y", "120", "--root", root], { cwd: path.resolve("."), stdio: "pipe" });
    const { project } = await core.loadFigModel(root);
    const g = project.figures[0].guides;
    assert(eq(g?.x, [200, 600]) && eq(g?.y, [120]), `CLI set-guides → x=${JSON.stringify(g?.x)} y=${JSON.stringify(g?.y)}`);
  } catch (e) {
    assert(false, `CLI set-guides failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // live bridge set_guides — matches + undoable
  const proj: Project = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 500, background: "#fff", elements: [] }],
    assets: [], palette: [],
  };
  store.loadProject(structuredClone(proj), null);
  store.activeFigureId.set("f1");
  await dispatchCommand({ type: "set_guides", figureId: "f1", x: [408], y: [64, 32] });
  const fg = () => get(store.project).figures[0].guides;
  assert(eq(fg()?.x, [408]) && eq(fg()?.y, [32, 64]), `bridge set_guides → x=${JSON.stringify(fg()?.x)} y=${JSON.stringify(fg()?.y)}`);
  store.undo();
  assert(!fg() || eq(fg()?.x, []), "bridge set_guides undoable");

  console.log(fails === 0 ? "\nF11 PARITY ALL PASS" : `\nF11 PARITY ${fails} FAILURE(S)`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
