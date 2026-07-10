#!/usr/bin/env -S npx tsx
// W11a acceptance (AGT-6 + AGT-13): the figure verbs that were live-bridge-only now
// exist in flux-core (→ CLI + MCP), so a CLOSED-app agent can delete/align/group/
// set-z/set-layout/duplicate/delete a figure — and restyle_part rejects typo'd part
// ids instead of silently writing an inert override.
//   Run: npx tsx scripts/verify-w11-verbs.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import { elementBBox } from "../src/lib/geometry";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
async function throws(fn: () => Promise<unknown>, needle: string, msg: string) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    const m = e instanceof Error ? e.message : String(e);
    assert(m.toLowerCase().includes(needle.toLowerCase()), `${msg} (message mentions "${needle}")`);
  }
  assert(threw, `${msg} — did throw`);
}

// Read a figure back from the saved canvas file (the on-disk truth an agent sees).
async function readFig(root: string, figId: string): Promise<any> {
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  const entry = idx.figures.find((f: any) => f.id === figId);
  if (!entry) return null;
  const cf = JSON.parse(await fs.readFile(path.join(root, "fig", "canvases", `${entry.canvas}.json`), "utf8"));
  return cf.figures.find((f: any) => f.id === figId);
}
async function figCount(root: string): Promise<number> {
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  return idx.figures.length;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w11-"));
try {
  await core.scaffold(root, { title: "W11" });

  // A figure with three path elements at distinct x offsets, so align has a visible effect.
  const { figureId: fig } = await core.createFigure(root, { id: "fig1", name: "Verbs" });
  const p1 = await core.addPath(root, fig, { nodes: [{ x: 10, y: 10, type: "corner" }, { x: 30, y: 10, type: "corner" }] });
  const p2 = await core.addPath(root, fig, { nodes: [{ x: 60, y: 40, type: "corner" }, { x: 80, y: 40, type: "corner" }] });
  const p3 = await core.addPath(root, fig, { nodes: [{ x: 120, y: 70, type: "corner" }, { x: 140, y: 70, type: "corner" }] });
  assert((await readFig(root, fig)).elements.length === 3, "created a figure with 3 elements");

  // group / ungroup ---------------------------------------------------------
  const { groupId } = await core.groupElements(root, [p1.id, p2.id]);
  let f = await readFig(root, fig);
  const byId = (id: string) => f.elements.find((e: any) => e.id === id);
  assert(byId(p1.id).groupId === groupId && byId(p2.id).groupId === groupId, "group: both elements share the new groupId");
  assert(byId(p3.id).groupId == null, "group: the untouched element is not in the group");
  await throws(() => core.groupElements(root, [p1.id]), "≥2", "group of a single element is rejected");

  await core.ungroupElements(root, [p1.id, p2.id]);
  f = await readFig(root, fig);
  assert(byId(p1.id).groupId == null && byId(p2.id).groupId == null, "ungroup: groupId cleared on both");

  // align (left) — every element's bbox.x collapses to the same minimum --------
  await core.alignFigure(root, fig, "left");
  f = await readFig(root, fig);
  const xs = f.elements.map((e: any) => Math.round(elementBBox(e).x));
  assert(new Set(xs).size === 1, `align left: all bbox x equal (${xs.join(",")})`);

  // set-z (front) — the selected element moves to the end of the elements array
  await core.setZOrder(root, fig, [p1.id], "front");
  f = await readFig(root, fig);
  assert(f.elements[f.elements.length - 1].id === p1.id, "set-z front: element is last (front-most) in the figure");

  // set-figure-layout — only passed fields change --------------------------
  await core.setFigureLayout(root, fig, { width: 999, name: "Renamed" });
  f = await readFig(root, fig);
  assert(f.width === 999 && f.name === "Renamed", "set-figure-layout: width + name applied");

  // delete-element ----------------------------------------------------------
  await core.deleteElements(root, [p3.id]);
  f = await readFig(root, fig);
  assert(!f.elements.some((e: any) => e.id === p3.id) && f.elements.length === 2, "delete-element: removed one, two remain");

  // duplicate-figure / delete-figure ---------------------------------------
  const before = await figCount(root);
  const dup = await core.duplicateFigure(root, fig);
  assert((await figCount(root)) === before + 1, "duplicate-figure: figure count +1");
  const dupFig = await readFig(root, dup.figureId);
  assert(dupFig && dupFig.elements.length === 2, "duplicate-figure: copy carries the same element count");
  assert(dupFig.elements.every((e: any) => !f.elements.some((o: any) => o.id === e.id)), "duplicate-figure: copy has fresh element ids");

  const del = await core.deleteFigure(root, dup.figureId);
  assert((await figCount(root)) === before, "delete-figure: figure count back to baseline");
  assert(del.nextActiveId != null, "delete-figure: returns a nextActiveId");
  await throws(() => core.deleteFigure(root, "does-not-exist"), "not found", "delete-figure on a missing id errors");

  // AGT-13: restyle_part validates the partId against the manifest -----------
  const svg = path.join(root, "bars.svg");
  await fs.writeFile(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
      `<rect id="bar1" x="20" y="40" width="30" height="60" fill="#888"/>` +
      `<rect id="bar2" x="80" y="20" width="30" height="80" fill="#888"/></svg>`,
  );
  await fs.writeFile(
    svg.replace(/\.svg$/, ".fluxplot.json"),
    JSON.stringify({
      specVersion: "0.2.0",
      parts: { id: "root", role: "container", children: [{ id: "bars", role: "group", members: ["bar1", "bar2"] }] },
      series: [],
    }),
  );
  const comp = await core.composeFigure(root, [svg], { id: "barfig", captionStub: false });
  await throws(
    () => core.setPartOverride(root, comp.figureId, "not-a-real-part", { fill: "#e00000" }),
    "unknown part",
    "AGT-13: restyle_part with a typo'd partId is rejected",
  );
  // A valid part id (the group) still works.
  await core.setPartOverride(root, comp.figureId, "bars", { fill: "#e00000" });
  const rendered = await core.renderFigureSvg(root, comp.figureId);
  assert((rendered.match(/#e00000/g) || []).length >= 2, "AGT-13: a valid partId still applies (group override expands)");

  // Headless placement: a second composed figure stacks BELOW the first
  // (createFigure default), never on top of it at 0,0.
  const comp2 = await core.composeFigure(root, [svg], { id: "barfig2", captionStub: false });
  const f1 = await readFig(root, comp.figureId);
  const f2 = await readFig(root, comp2.figureId);
  assert(f2.y >= f1.y + f1.height, `compose-figure stacks below the previous figure (y=${f2.y} vs bottom=${f1.y + f1.height})`);

  // render-canvas: whole-canvas look shows every figure + its label.
  const canvas = await core.renderCanvasSvg(root);
  assert(canvas.svg.includes(`x="${f2.x}" y="${f2.y}"`), "render-canvas nests figures at their canvas x/y");
  assert(canvas.svg.includes("barfig2"), "render-canvas labels figures with name·id");

  // delete-figure headless: renders are unlinked, no placeholder backfill,
  // and list_project exposes element counts (empty figures visible).
  await core.materializeRenders(root);
  const renderPath = path.join(root, "fig", "renders", `${comp2.figureId}.svg`);
  assert(await fs.access(renderPath).then(() => true, () => false), "materialize wrote the render");
  await core.deleteFigure(root, comp2.figureId);
  assert(!(await fs.access(renderPath).then(() => true, () => false)), "delete-figure unlinks fig/renders/<id>.svg");
  const listed = await core.listProject(root);
  assert(listed.figures.every((fg: any) => typeof fg.elements === "number"), "list exposes per-figure element counts");
  const total = await figCount(root);
  for (const fg of listed.figures) await core.deleteFigure(root, fg.id);
  assert((await figCount(root)) === 0 && total > 0, "headless delete-figure never backfills a placeholder blank");

  console.log("\nW11 VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
