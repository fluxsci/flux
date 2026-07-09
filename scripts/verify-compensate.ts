#!/usr/bin/env -S npx tsx
// figure-v1 Phase 5 — pt-true resize compensation (plot/compensate.ts).
//
// Contract: resizing a plot/svg element rescales GEOMETRY only; text glyphs,
// tick/marker glyphs, stroke widths and dash patterns keep true point size
// (matplotlib figsize semantics). Factors derive from element box vs intrinsic
// size × contentScale; crop windows re-base the factors on the visible rect.
//
//  Run: npx tsx scripts/verify-compensate.ts
import { parseHTML, DOMParser } from "linkedom";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as { document?: unknown }).document = document;
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } = await import("../src/lib/plot/compensate");
const { parsePlotSvg } = await import("../src/lib/plot/parse");
const { normalizeSvgForParts } = await import("../src/lib/plot/derive");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

// matplotlib-shaped: pt sizing (360pt × 216pt → 480×288 CSS px intrinsic),
// rotated y-label, gridline stroke, dashed reference line, shared-def tick.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="360pt" height="216pt" viewBox="0 0 360 216">
 <g id="figure">
  <g id="grid"><path d="M 10 0 L 10 216" style="fill: none; stroke: #dad8ce; stroke-width: 0.8"/></g>
  <g id="dash"><path d="M 0 100 L 360 100" style="fill: none; stroke: #999; stroke-width: 1.2; stroke-dasharray: 4 2"/></g>
  <g id="tickwrap">
   <defs><path id="mT" d="M 0 0 L 0 4.5" style="stroke: #575653"/></defs>
   <g><use xlink:href="#mT" x="10" y="216" style="stroke: #575653"/></g>
  </g>
  <g id="xlabel"><text style="font-size: 5px; fill: #100f0f" x="180" y="210">time</text></g>
  <g id="ylabel"><text style="font-size: 5px; fill: #100f0f" x="8" y="108" transform="rotate(-90 8 108)">volts</text></g>
 </g>
</svg>`;

function prep(): Element {
  const root = parsePlotSvg(SVG) as unknown as Element;
  normalizeSvgForParts(root);
  return root;
}

console.log("intrinsics:");
const r0 = prep();
const intrinsic = svgIntrinsicPx(r0);
assert(intrinsic.w === 480 && intrinsic.h === 288, "360pt × 216pt → 480 × 288 CSS px (pt = 4/3 px)");

// ---------------------------------------------------------------------------
// 1. True size → byte-identical no-op
// ---------------------------------------------------------------------------
console.log("no-op at true size:");
const rNoop = prep();
const before = String(rNoop);
compensatePtTrue(rNoop, { elW: 480, elH: 288, intrinsic });
assert(String(rNoop) === before, "compensation at true size leaves the DOM untouched");

// ---------------------------------------------------------------------------
// 2. Uniform half-size: fx = fy = 2
// ---------------------------------------------------------------------------
console.log("uniform half size (fx=fy=2):");
const rHalf = prep();
compensatePtTrue(rHalf, { elW: 240, elH: 144, intrinsic });

const xt = rHalf.querySelector('[id="xlabel"] text') as Element;
assert(
  (xt.getAttribute("transform") ?? "").startsWith("translate(180 210) scale(2 2) translate(-180 -210)"),
  "text counter-scale PREPENDED, anchored at the text's own x/y",
);
const yt = rHalf.querySelector('[id="ylabel"] text') as Element;
const ytr = yt.getAttribute("transform") ?? "";
assert(
  ytr.startsWith("translate(8 108) scale(2 2) translate(-8 -108)") && ytr.endsWith("rotate(-90 8 108)"),
  "rotated label: C prepends BEFORE the original rotate (undistorted under any resize)",
);
const grid = rHalf.querySelector('[id="grid"] path') as SVGElement;
assert(grid.style.strokeWidth === "1.6", "stroke-width 0.8 × geomean(2,2) = 1.6 (renders at true pt after ½ geometry)");
const dash = rHalf.querySelector('[id="dash"] path') as SVGElement;
assert(dash.style.strokeDasharray === "8 4", "dash pattern compensated by the same factor");
const glyph = rHalf.querySelector('[id="tickwrap"] path[data-flux-glyph="1"]') as Element;
const gtr = glyph.getAttribute("transform") ?? "";
assert(
  gtr.startsWith("translate(10 216)") && gtr.endsWith("scale(2 2)"),
  "inlined tick glyph: scale APPENDED after its translate anchor (pt-true length, anchored position)",
);
assert(!(glyph as unknown as SVGElement).style.strokeWidth, "glyph stroke NOT double-compensated (transform already scales it)");

// ---------------------------------------------------------------------------
// 3. Anisotropic resize: width-only shrink (fx=2, fy=1)
// ---------------------------------------------------------------------------
console.log("anisotropic (fx=2, fy=1):");
const rAniso = prep();
compensatePtTrue(rAniso, { elW: 240, elH: 288, intrinsic });
const yt2 = rAniso.querySelector('[id="ylabel"] text') as Element;
assert(
  (yt2.getAttribute("transform") ?? "").startsWith("translate(8 108) scale(2 1) translate(-8 -108)"),
  "anisotropic counter-scale undoes both axes independently (glyphs undistorted)",
);
const grid2 = rAniso.querySelector('[id="grid"] path') as SVGElement;
assert(
  Math.abs(parseFloat(grid2.style.strokeWidth) - 0.8 * Math.SQRT2) < 1e-9,
  "stroke factor = geomean(fx,fy) = √2 under width-only shrink",
);

// ---------------------------------------------------------------------------
// 4. contentScale (the K tool) — geometric scaling
// ---------------------------------------------------------------------------
console.log("contentScale:");
const rK = prep();
// K-scaled 2×: elW=960, contentScale=2 → factors (480/960)·2 = 1 → geometric no-op
const beforeK = String(rK);
compensatePtTrue(rK, { elW: 960, elH: 576, contentScale: 2, intrinsic });
assert(String(rK) === beforeK, "K tool: contentScale folds into the factors — pure geometric scaling, no counter-transforms");
// then plain-shrink back to half of THAT: elW=480 with cs=2 → factors = 2 (glyphs render 2× pt)
const rK2 = prep();
compensatePtTrue(rK2, { elW: 480, elH: 288, contentScale: 2, intrinsic });
const ktext = rK2.querySelector('[id="xlabel"] text') as Element;
assert(
  (ktext.getAttribute("transform") ?? "").includes("scale(2 2)"),
  "plain resize after K keeps the scaled pt size (cs multiplies the factors)",
);

// ---------------------------------------------------------------------------
// 5. Crop re-bases the factors on the visible window
// ---------------------------------------------------------------------------
console.log("crop:");
const crop = { x: 120, y: 72, width: 240, height: 144 }; // middle half (intrinsic px)
const vbv = cropViewBoxValue("0 0 360 216", intrinsic, crop);
assert(vbv === "90 54 180 108", "cropViewBoxValue converts intrinsic px → viewBox units (×0.75 for pt files)");
const rCrop = prep();
// visible 240×144 intrinsic px shown in a 240×144 box → TRUE SIZE for the window → no-op
const beforeC = String(rCrop);
compensatePtTrue(rCrop, { elW: 240, elH: 144, crop, intrinsic });
assert(String(rCrop) === beforeC, "crop window at its true size needs no compensation");
const rCrop2 = prep();
compensatePtTrue(rCrop2, { elW: 120, elH: 72, crop, intrinsic });
const ct = rCrop2.querySelector('[id="xlabel"] text') as Element;
assert((ct.getAttribute("transform") ?? "").includes("scale(2 2)"), "half-size crop window → factors from crop dims, not full content");

// ---------------------------------------------------------------------------
// 6. defs/nested-svg exclusions
// ---------------------------------------------------------------------------
console.log("exclusions:");
const NESTED = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <defs><path id="keep" d="M0 0" style="stroke:#000; stroke-width: 3"/></defs>
  <svg width="10" height="10"><text x="0" y="0" style="font-size: 4px">alien</text></svg>
  <clipPath id="cp"><rect width="5" height="5"/></clipPath>
</svg>`;
const rN = parsePlotSvg(NESTED) as unknown as Element;
const beforeN = String(rN);
compensatePtTrue(rN, { elW: 50, elH: 50, intrinsic: { w: 100, h: 100 } });
assert(String(rN) === beforeN, "defs / nested-svg / clipPath subtrees untouched");

console.log("\nverify-compensate: ALL OK");
