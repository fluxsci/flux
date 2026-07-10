#!/usr/bin/env -S npx tsx
// Extreme-geometry hygiene + geometry-aware sync (moma feedback #5/#7/#10).
//
// #5: the old clamp matched raw digit RUNS, so ordinary 6-decimal coordinates
// ("12.972623") counted as "absurd ≥100k" — hundreds of false warnings on
// valid linear plots, with the fraction silently rewritten. And the REAL moma
// crash coordinate (−61,514) sat below 100k, untouched. scanAbsurdPathCoords
// tokenizes properly, thresholds relative to the viewBox, and names ids.
//
// #7: resvg panics (geom.rs) on clipped paths reaching ≈1.6× beyond the canvas
// under nested-<svg> composition — ±90,000 (and 4× the canvas) still crashed
// it. Clamps now land at −0.25×/1.25× the canvas (empirically safe, pixels
// identical); validate-plot REJECTS such geometry at the source with the id,
// value, and a log-axis-aware hint.
//
// #10: sync-figure reconciles a regenerated plot's NEW intrinsic size — the
// element resizes (preserving deliberate user scale) and the figure frame
// grows to keep content unclipped.
//
// Run: npx tsx scripts/verify-fig-geometry.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// ---- unit: scanAbsurdPathCoords -------------------------------------------
{
  // Ordinary matplotlib output: 6-decimal fractions must NOT clamp (the old
  // false positive), including negative values and exponent-free decimals.
  const clean =
    `<svg xmlns="http://www.w3.org/2000/svg" width="378pt" height="226.8pt" viewBox="0 0 378 226.8">` +
    `<path d="M 12.972623 145.347514 L -49.858897 3.000240 L 0.123456 0.654321 z"/></svg>`;
  const s1 = core.scanAbsurdPathCoords(clean, { clamp: true });
  assert(s1.clamped === 0, `6-decimal fractions never count as absurd (got ${s1.clamped})`);
  assert(s1.svg === clean, "clean SVG passes through byte-identical");

  // The moma crash shape: −61,514 in a 378-unit viewBox, inside a tagged group.
  const broken =
    `<svg xmlns="http://www.w3.org/2000/svg" width="378pt" height="226.8pt" viewBox="0 0 378 226.8">` +
    `<g id="counts.bar.3" data-role="bar"><path d="M -61514.806383 186.653981 L 224.810182 186.653981 L 224.810182 180.378741 L -61514.806383 180.378741 z"/></g></svg>`;
  const s2 = core.scanAbsurdPathCoords(broken, { clamp: true });
  assert(s2.clamped === 2, `both −61,514 tokens caught (got ${s2.clamped})`);
  assert(s2.ids.includes("counts.bar.3"), `offending id captured (got ${s2.ids.join(",")})`);
  assert(Math.round(Math.abs(s2.values[0])) === 61515, `worst value reported (got ${s2.values[0]})`);
  const maxDim = 378 * (96 / 72); // pt → px intrinsic
  const clampedVals = [...s2.svg.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const minVal = Math.min(...clampedVals);
  assert(minVal >= -0.26 * maxDim, `negative clamp target just outside the canvas (min ${minVal})`);
  assert(!s2.svg.includes("61514"), "no absurd coordinate survives the clamp");

  // Exponent + non-finite tokens.
  const weird =
    `<svg width="300" height="200" viewBox="0 0 300 200"><path d="M 1e6 NaN L 2.5e5 10 L -Infinity 5"/></svg>`;
  const s3 = core.scanAbsurdPathCoords(weird, { clamp: true });
  assert(s3.clamped >= 4, `exponent + NaN/Inf tokens all caught (got ${s3.clamped})`);
  assert(!/NaN|Inf|e6|e5/i.test(s3.svg.replace(/<svg[^>]*>/, "")), "no non-finite/exponent token survives");

  // Threshold is viewBox-relative: the same 61k value in a 100,000-unit canvas is legit.
  const bigCanvas = `<svg width="100000" height="100000" viewBox="0 0 100000 100000"><path d="M 61514 5 L 99000 10"/></svg>`;
  const s4 = core.scanAbsurdPathCoords(bigCanvas, { clamp: true });
  assert(s4.clamped === 0, "large-canvas SVGs keep their large coordinates");
}

// ---- pipeline: compose warns precisely, render survives, validate rejects --
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-geometry-"));
try {
  await core.scaffold(root, { title: "Geometry" });
  const plotsDir = path.join(root, "plots");
  await fs.mkdir(plotsDir, { recursive: true });

  // A minimal fluxplot-shaped pair: log-axis manifest + a zero-anchored bar
  // whose serialized anchor is the moma −61,514 pathology, plus a clean bar —
  // BOTH clipped (the resvg panic needs the clip interplay).
  const brokenSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="378pt" height="226.8pt" viewBox="0 0 378 226.8" data-fluxplot="1">` +
    `<defs><clipPath id="clipA"><rect x="56.24" y="23.57" width="102.46" height="170.84"/></clipPath>` +
    `<clipPath id="clipB"><rect x="217.82" y="23.57" width="153.69" height="170.84"/></clipPath></defs>` +
    `<g id="plot-area" data-role="plot-area">` +
    `<g id="dept.bar.0" data-role="bar"><path id="n1" d="M 56.24 47.27 L 153.82 47.27 L 153.82 31.34 L 56.24 31.34 z" clip-path="url(#clipA)" style="fill: #205ea6"/></g>` +
    `<g id="cls.bar.0" data-role="bar"><path id="n2" d="M -61514.806383 186.65 L 224.81 186.65 L 224.81 180.37 L -61514.806383 180.37 z" clip-path="url(#clipB)" style="fill: #bc5215"/></g>` +
    `</g></svg>`;
  const manifest = {
    spec: "fluxplot/manifest",
    schemaVersion: "0.2.0",
    axes: [
      { id: "plot-area", x: { scale: "linear" }, y: { scale: "linear" } },
      { id: "plot-area", x: { scale: "log" }, y: { scale: "linear" } },
    ],
    series: [{ id: "cls" }],
    parts: { id: "root", children: [{ id: "cls.bar.0", ref: "cls.bar.0" }] },
  };
  await fs.writeFile(path.join(plotsDir, "logbars.svg"), brokenSvg);
  await fs.writeFile(path.join(plotsDir, "logbars.fluxplot.json"), JSON.stringify(manifest));

  // validate-plot REJECTS the source with id + value + log hint (#7).
  const v = await core.validatePlot(path.join(plotsDir, "logbars.svg"));
  assert(!v.ok, "validate-plot rejects the zero-anchored log-bar source");
  const geoErr = v.errors.find((e) => e.includes("path coordinate"));
  assert(!!geoErr, "a geometry error is reported");
  assert(geoErr!.includes("cls.bar.0"), "the offending id is named");
  assert(geoErr!.includes("-61,515") || geoErr!.includes("61,515"), "the offending value is named");
  assert(geoErr!.includes("log axis"), "the hint is log-axis-aware");

  // compose warns ONCE, precisely; a healthy plot warns ZERO times (#5).
  const cleanSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220" viewBox="0 0 300 220">` +
    `<path d="M 12.972623 145.347514 L 0.123456 0.654321 L 299.999999 219.123456"/></svg>`;
  await fs.writeFile(path.join(plotsDir, "clean.svg"), cleanSvg);
  const okCompose = await core.composeFigure(root, [path.join(plotsDir, "clean.svg")], { id: "cleanfig" });
  assert(okCompose.warnings.length === 0, "healthy plot composes with zero warnings");

  const r = await core.composeFigure(root, [path.join(plotsDir, "logbars.svg")], { id: "brokefig" });
  assert(r.warnings.length === 1, `broken plot composes with exactly one warning (got ${r.warnings.length})`);
  assert(r.warnings[0].includes("cls.bar.0") && r.warnings[0].includes("log axis"), "warning names the id and the log-axis remedy");

  // The composed figure RENDERS — the clamp keeps resvg alive (#7); pixels of
  // the clean panel unaffected.
  const png = await core.renderFigurePng(root, "brokefig", 2);
  assert(png.length > 1000 && png[0] === 0x89, `composed broken plot renders to a real PNG (${png.length} bytes)`);

  // ---- #10: regenerate at a NEW intrinsic size → element + frame reconcile.
  const grow = (h: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${h}" viewBox="0 0 300 ${h}">` +
    `<path d="M 10 10 L 290 ${h - 10}"/></svg>`;
  await fs.writeFile(path.join(plotsDir, "grower.svg"), grow(200));
  const comp = await core.composeFigure(root, [path.join(plotsDir, "grower.svg")], { id: "growfig" });
  const frameBefore = { w: comp.width, h: comp.height };
  await fs.writeFile(path.join(plotsDir, "grower.svg"), grow(320)); // regenerated taller
  const sync = await core.syncFigureAssets(root, "growfig");
  assert(sync.refreshed.length === 1, "sync refreshed the regenerated asset");
  assert(sync.resized.length === 1, "sync reports the intrinsic-size change");
  assert(Math.round(sync.resized[0].to.h) === 320, `element resized to the new height (got ${sync.resized[0].to.h})`);
  assert(sync.framed.length === 1 && sync.framed[0].to.height > frameBefore.h,
    `frame grew to fit (${frameBefore.h} → ${sync.framed[0]?.to.height})`);
  {
    const { project } = await core.loadFigModel(root);
    const fig = project.figures.find((f) => f.id === "growfig")!;
    const el = fig.elements.find((e) => e.type === "plot")!;
    assert(Math.round(el.height) === 320, `element height persisted (got ${el.height})`);
    assert(fig.height >= el.y + el.height, "figure frame contains the grown panel");
  }

  // User scale survives: halve the element (the real scale verb), regenerate
  // at 400 → sync lands the element at 400 × 0.5 = 200, not 400.
  {
    const { project } = await core.loadFigModel(root);
    const el = project.figures.find((f) => f.id === "growfig")!.elements.find((e) => e.type === "plot")!;
    await core.scaleElements(root, [el.id], 0.5);
    await fs.writeFile(path.join(plotsDir, "grower.svg"), grow(400));
    const s2 = await core.syncFigureAssets(root, "growfig");
    assert(s2.resized.length === 1, "scaled-element sync still reports resize");
    const { project: p3 } = await core.loadFigModel(root);
    const el3 = p3.figures.find((f) => f.id === "growfig")!.elements.find((e) => e.type === "plot")!;
    assert(Math.round(el3.height) === 200, `deliberate 0.5× user scale preserved (400 × 0.5; got ${el3.height})`);
  }

  console.log("\nALL GEOMETRY TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
