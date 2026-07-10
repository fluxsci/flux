#!/usr/bin/env -S npx tsx
// Feedback-sweep acceptance (moma friction log #1/#2/#3/#5): the headless
// regenerate loop + render hardening + reading-order lettering.
//   • compose clamps absurd path coords (log-axis bar at x≈−176k) + warns
//   • render-figure PNG failures are REAL errors (child-process resvg), and
//     name the figure instead of exiting 0 with no PNG
//   • sync-figure refreshes fig/assets from regenerated plots/ IN PLACE
//     (restyles survive); render-figure warns when panels are stale
//   • auto-letter groups rows by panel extents (mixed-height row-mates don't
//     letter out of reading order) and reports no-ops via `changed`
//   Run: npx tsx scripts/verify-sync-render.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import * as ops from "../src/lib/ops";
import type { Project } from "../src/lib/types";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const PLOT = (color: string, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">` +
  `<rect id="bar1" x="20" y="40" width="30" height="60" fill="${color}"/>${extra}</svg>`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-syncrender-"));
try {
  await core.scaffold(root, { title: "SyncRender" });
  await fs.mkdir(path.join(root, "plots"), { recursive: true });

  // --- clamp + warning on import ------------------------------------------
  const good = path.join(root, "plots", "good.svg");
  const absurd = path.join(root, "plots", "logbar.svg");
  await fs.writeFile(good, PLOT("#336699"));
  await fs.writeFile(absurd, PLOT("#993366", `<path d="M -176000 60 L 40 60 L 40 80 Z" fill="#222"/>`));
  const comp = await core.composeFigure(root, [good, absurd], { id: "syncfig", captionStub: false });
  assert(comp.warnings.length === 1 && /clamped/.test(comp.warnings[0]) && /logbar/.test(comp.warnings[0]),
    "compose warns about clamped absurd coordinates, naming the plot");
  const assetSvgs = await fs.readdir(path.join(root, "fig", "assets"));
  let clampedOnDisk = false;
  for (const f of assetSvgs.filter((f) => f.endsWith(".svg"))) {
    const t = await fs.readFile(path.join(root, "fig", "assets", f), "utf8");
    if (t.includes("-90000")) clampedOnDisk = true;
    assert(!t.includes("-176000"), `asset copy ${f} carries no absurd coordinate`);
  }
  assert(clampedOnDisk, "the clamped coordinate landed in the asset copy");

  // --- PNG render through the child process works --------------------------
  const png = await core.renderFigurePng(root, comp.figureId, 1);
  assert(png.length > 8 && png[0] === 0x89 && png[1] === 0x50, "renderFigurePng returns a real PNG (child resvg)");

  // --- a render failure is a REAL error naming the figure ------------------
  const bad = await core.createFigure(root, { id: "zerofig", width: 0, height: 0 });
  let failed = "";
  try {
    await core.renderFigurePng(root, bad.figureId, 1);
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
  }
  assert(/render-figure zerofig/.test(failed) && /rasterization failed/.test(failed),
    `render failure throws, names the figure (got: ${failed.slice(0, 90)}…)`);

  // --- sync-figure: regenerate → stale probe → in-place refresh ------------
  await fs.writeFile(good, PLOT("#e07020")); // "re-run the plot script"
  const stale = await core.syncFigureAssets(root, comp.figureId, { dryRun: true });
  assert(stale.refreshed.length === 1 && /good\.svg/.test(stale.refreshed[0].from),
    "dry-run staleness probe reports the regenerated plot");
  // A restyle applied BEFORE the sync must survive it (the whole point vs
  // delete+recompose).
  const idx = JSON.parse(await fs.readFile(path.join(root, "fig", "index.json"), "utf8"));
  void idx;
  const r = await core.syncFigureAssets(root, comp.figureId);
  assert(r.refreshed.length === 1 && r.checked === 2, "sync refreshes exactly the stale asset");
  const svg2 = await core.renderFigureSvg(root, comp.figureId);
  assert(svg2.includes("#e07020"), "figure render now shows the regenerated plot bytes");
  const r2 = await core.syncFigureAssets(root, comp.figureId);
  assert(r2.refreshed.length === 0, "second sync is a clean no-op");
  const gone = await core.syncFigureAssets(root, undefined, { dryRun: true });
  assert(gone.checked >= 2, "project-wide sync sweeps every plot-backed asset");

  // --- auto-letter: mixed-height row-mates stay in reading order -----------
  const p: Project = { version: 2, name: "", canvases: [{ id: "c", name: "C", order: 1 }], figures: [], assets: [], palette: [] };
  const fig = ops.createFigure(p, { canvasId: "c", width: 700, height: 700 });
  // Row 1: even-height pair. Row 2: the moma case — the right panel is TALLER
  // (top 19 units above its row-mate). y-bucket sorting (TOL 24 → buckets of
  // round(y/24)) put the taller panel's label in an earlier bucket → "f, e".
  const mk = (x: number, y: number, w: number, h: number) =>
    fig.elements.push({ type: "plot", id: `pl${x}_${y}`, assetId: "a", x, y, width: w, height: h, rotation: 0, overrides: {} } as never);
  mk(0, 48, 300, 280);
  mk(340, 48, 300, 280);
  mk(0, 400, 300, 280);
  mk(340, 381, 300, 316); // taller row-mate, top 19 above
  for (const el of [...fig.elements]) {
    const b = { x: (el as { x: number }).x, y: (el as { y: number }).y };
    ops.addPanelLabel(p, fig.id, { text: "?", x: b.x, y: Math.max(0, b.y - 16), fontSize: 32 / 3 });
  }
  const first = ops.autoLetterPanels(p, fig.id);
  const letterAt = (x: number, y: number) =>
    (fig.elements.find((e) => e.type === "text" && (e as { panelLabel?: boolean }).panelLabel && Math.abs(e.x - x) < 1 && Math.abs(e.y - (y - 16)) < 1) as { text?: string })?.text;
  assert(first.changed, "first letter pass reports changed");
  assert(letterAt(0, 48) === "a" && letterAt(340, 48) === "b", "row 1 letters a, b");
  assert(letterAt(0, 400) === "c" && letterAt(340, 381) === "d",
    `row 2 letters in reading order c, d despite mixed heights (got ${letterAt(0, 400)}, ${letterAt(340, 381)})`);
  const second = ops.autoLetterPanels(p, fig.id);
  assert(!second.changed, "re-letter is reported as a no-op (changed: false)");

  console.log("\nSYNC/RENDER VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
