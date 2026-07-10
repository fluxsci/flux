#!/usr/bin/env -S npx tsx
// Panel-letter reading order + label creation (moma feedback #4/#6).
//
// #6: compose-figure --cols N places plots row-major in INPUT order; the
// letters must land on those same panels (a,b on the first row — not the
// a/c-b/d column scramble). The scramble came from label→panel association by
// whole-bbox distance: a row-2 label 16 above its panel sat nearer the row-1
// panel's BOTTOM edge whenever the row gap ≤ 16, adopted the wrong row span,
// and the merged "row" lettered in column order. Association now measures the
// panel's TOP-LEFT region only (ops.panelForLabel).
//
// #4: auto-label on a figure whose panels have no labels (import-plots +
// arrange) creates the missing labels first, then letters — the old behavior
// was a hard dead-end ("no panel labels to letter"). add-fig-text --panel-label
// (core addFigText {panelLabel:true}) creates a letterable label.
//
// Run: npx tsx scripts/verify-fig-letterorder.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

type El = { id: string; type: string; x: number; y: number; text?: string; panelLabel?: boolean };

/** letters keyed by the input panel they sit on (label at panel top-left). */
function lettersByPanel(fig: { elements: El[] }): string[] {
  const plots = fig.elements.filter((e) => e.type === "plot");
  const labels = fig.elements.filter((e) => e.type === "text" && e.panelLabel);
  return plots.map((p) => {
    let best: { d: number; text: string } | null = null;
    for (const l of labels) {
      const d = Math.hypot(l.x - p.x, l.y - (p.y - 16));
      if (!best || d < best.d) best = { d, text: l.text ?? "" };
    }
    return best && best.d <= 24 ? best.text : "?";
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-letters-"));
try {
  await core.scaffold(root, { title: "Letter Order" });
  const plotsDir = path.join(root, "plots");
  await fs.mkdir(plotsDir, { recursive: true });
  const mk = async (name: string, w: number, h: number) => {
    const p = path.join(plotsDir, `${name}.svg`);
    await fs.writeFile(
      p,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
        `<rect width="${w}" height="${h}" fill="#eef"/><text x="10" y="20">${name}</text></svg>`,
    );
    return p;
  };

  // ---- #6: five uniform-height panels (the moma fig1 shape), 2 columns.
  // Row gap ≈ label offset — exactly the geometry that scrambled letters.
  const five = [
    await mk("pa", 322, 216),
    await mk("pb", 322, 216),
    await mk("pc", 322, 216),
    await mk("pd", 322, 216),
    await mk("pe", 504, 216),
  ];
  const r1 = await core.composeFigure(root, five, { id: "gridfive", cols: 2 });
  assert(r1.panels.join("") === "abcde", `compose reports letters abcde (got ${r1.panels.join("")})`);
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "gridfive")! as unknown as { elements: El[] };
    const got = lettersByPanel(fig).join("");
    assert(got === "abcde", `--cols 2 letters land row-major on input panels (got ${got})`);
  }

  // ---- #6: mixed heights (short/tall row-mates) still letter row-major.
  const mixed = [await mk("qa", 300, 150), await mk("qb", 300, 260), await mk("qc", 300, 260), await mk("qd", 300, 150)];
  await core.composeFigure(root, mixed, { id: "gridmixed", cols: 2 });
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "gridmixed")! as unknown as { elements: El[] };
    const got = lettersByPanel(fig).join("");
    assert(got === "abcd", `mixed-height --cols 2 letters stay row-major (got ${got})`);
  }

  // ---- #4: import-plots onto a blank figure → arrange → auto-label CREATES.
  await core.createFigure(root, { id: "blankfig", width: 900, height: 700 });
  await core.importPlots(root, "blankfig", [five[0], five[1], five[2], five[3]]);
  await core.arrangeFigure(root, "blankfig", { cols: 2 });
  const al = await core.autoLabel(root, "blankfig");
  assert(al.created === 4, `auto-label created the 4 missing labels (got ${al.created})`);
  assert(al.panels.join("") === "abcd", `auto-label lettered abcd (got ${al.panels.join("")})`);
  {
    // import-plots packs by ITS OWN rule (GUI autoArrange parity), so input
    // order ≠ geometry here; the letter contract is geometric reading order:
    // sorting panels by (row, x) must give a,b,c,d.
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "blankfig")! as unknown as { elements: El[] };
    const letters = lettersByPanel(fig);
    const plots = fig.elements.filter((e) => e.type === "plot");
    const order = plots.map((p, i) => ({ i, x: p.x, y: p.y })).sort((a, b) => (Math.abs(a.y - b.y) < 20 ? a.x - b.x : a.y - b.y));
    const got = order.map((o) => letters[o.i]).join("");
    assert(got === "abcd", `created labels letter in geometric reading order (got ${got})`);
  }
  // Re-running is a no-op (no duplicate labels).
  const al2 = await core.autoLabel(root, "blankfig");
  assert(al2.created === 0 && !al2.changed, "second auto-label creates nothing and changes nothing");

  // ---- #4: partially labeled figure only gains the MISSING labels.
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "gridmixed")!;
    const firstLabel = fig.elements.find((e) => e.type === "text" && (e as { panelLabel?: boolean }).panelLabel)!;
    await core.deleteElements(root, [firstLabel.id]);
  }
  const al3 = await core.autoLabel(root, "gridmixed");
  assert(al3.created === 1, `auto-label recreated exactly the deleted label (got ${al3.created})`);
  assert(al3.panels.join("") === "abcd", `letters back to abcd (got ${al3.panels.join("")})`);

  // ---- #4: add-fig-text {panelLabel:true} creates a letterable panel label.
  await core.createFigure(root, { id: "manual", width: 600, height: 400 });
  await core.addPanel(root, "manual", five[0], { x: 40, y: 40 });
  await core.addPanel(root, "manual", five[1], { x: 420, y: 40 });
  const t1 = await core.addFigText(root, "manual", { text: "?", panelLabel: true, x: 40, y: 24 });
  const t2 = await core.addFigText(root, "manual", { text: "?", panelLabel: true, x: 420, y: 24 });
  assert(!!t1.id && !!t2.id, "add-fig-text --panel-label returns element ids");
  const al4 = await core.autoLabel(root, "manual");
  assert(al4.panels.join("") === "ab", `manual panel labels lettered ab (got ${al4.panels.join("")})`);
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "manual")!;
    const labs = fig.elements.filter((e) => e.type === "text" && (e as { panelLabel?: boolean }).panelLabel);
    assert(labs.length === 2, `no extra labels created when all panels are marked (got ${labs.length})`);
  }

  console.log("\nALL LETTER-ORDER TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
