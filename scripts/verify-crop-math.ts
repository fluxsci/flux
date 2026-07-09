#!/usr/bin/env -S npx tsx
// figure-v1 P5 (pure) — crop math:
//   • cropRemap per handle: the dragged edge moves the BOX, the crop window
//     follows through the FIXED content→canvas mapping (content pinned);
//   • rotation (pointer inverse-rotated into the unrotated local frame),
//     flipX/flipY (mirrored mapping — box follows the pointer, the read-back
//     eats the mirrored content side), Shift (box keeps aspect), Alt
//     (symmetric about the centre), Shift+Alt;
//   • clamps: window ⊂ content, min ≥ max(1 intrinsic px, 1 canvas px);
//   • ops.setCrop: content-pinned box adjust, full-window normalization,
//     reset (null) round-trips a cropRemap edit back to the original box.
//
//  Run: npx tsx scripts/verify-crop-math.ts
import { cropRemap } from "../src/lib/editing";
import * as ops from "../src/lib/ops";
import type { Project, SemanticPlotElement, ImageElement, Element } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}
const near = (a: number | undefined, b: number, tol = 1e-9) => typeof a === "number" && Math.abs(a - b) <= tol;
const boxNear = (
  r: { x: number; y: number; width: number; height: number } | null,
  b: [number, number, number, number],
  tol = 1e-9,
) => !!r && near(r.x, b[0], tol) && near(r.y, b[1], tol) && near(r.width, b[2], tol) && near(r.height, b[3], tol);

const DISP = { width: 672, height: 480 };
const mkPlot = (over: Partial<SemanticPlotElement> = {}): SemanticPlotElement => ({
  type: "plot",
  id: "p1",
  x: 40,
  y: 40,
  width: 672,
  height: 480,
  rotation: 0,
  assetId: "a1",
  ...over,
});

// ---------------------------------------------------------------------------
// 1) plain per-handle math (1:1 scale — kx=ky=1, Ox=40, Oy=40)
// ---------------------------------------------------------------------------
{
  const el = mkPlot();
  const e = cropRemap(el, "e", { x: 512, y: 300 }, {}, DISP)!;
  assert(boxNear(e, [40, 40, 472, 480]), "E drag: box right edge follows the pointer, left edge PINNED");
  assert(boxNear(e.crop, [0, 0, 472, 480]), "E drag: crop follows (window = box through the fixed mapping)");

  const w = cropRemap(el, "w", { x: 140, y: 300 }, {}, DISP)!;
  assert(boxNear(w, [140, 40, 572, 480]), "W drag: box left edge follows");
  assert(boxNear(w.crop, [100, 0, 572, 480]), "W drag: crop.x advances by the same content px");

  const n = cropRemap(el, "n", { x: 300, y: 100 }, {}, DISP)!;
  assert(boxNear(n, [40, 100, 672, 420]) && boxNear(n.crop, [0, 60, 672, 420]), "N drag: top edge + crop.y");

  const s = cropRemap(el, "s", { x: 300, y: 400 }, {}, DISP)!;
  assert(boxNear(s, [40, 40, 672, 360]) && boxNear(s.crop, [0, 0, 672, 360]), "S drag: bottom edge, crop.y pinned");

  const se = cropRemap(el, "se", { x: 512, y: 400 }, {}, DISP)!;
  assert(boxNear(se, [40, 40, 472, 360]) && boxNear(se.crop, [0, 0, 472, 360]), "SE corner drags both axes");

  const nw = cropRemap(el, "nw", { x: 140, y: 100 }, {}, DISP)!;
  assert(boxNear(nw, [140, 100, 572, 420]) && boxNear(nw.crop, [100, 60, 572, 420]), "NW corner drags both axes");
}

// ---------------------------------------------------------------------------
// 2) non-1:1 content scale (element at 50% — kx=0.5): canvas px ↔ 2 content px
// ---------------------------------------------------------------------------
{
  const el = mkPlot({ width: 336, height: 240 });
  const e = cropRemap(el, "e", { x: 276, y: 100 }, {}, DISP)!; // 100 canvas px inward
  assert(boxNear(e, [40, 40, 236, 240]), "scaled: box narrows by the drag distance");
  assert(boxNear(e.crop, [0, 0, 472, 480]), "scaled: crop narrows by distance/kx (200 content px)");
}

// ---------------------------------------------------------------------------
// 3) starting FROM an existing crop + clamps to the content bounds
// ---------------------------------------------------------------------------
{
  const el = mkPlot({ x: 200, y: 100, width: 300, height: 200, crop: { x: 100, y: 50, width: 300, height: 200 } });
  // content spans canvas x ∈ [100, 772] (Ox = 200 − 100 = 100)
  const eOut = cropRemap(el, "e", { x: 900, y: 150 }, {}, DISP)!;
  assert(boxNear(eOut, [200, 100, 572, 200]), "E outward drag clamps the box at the content's right edge");
  assert(boxNear(eOut.crop, [100, 50, 572, 200]), "E outward: crop grows to the content bound (x+w = 672)");
  const wOut = cropRemap(el, "w", { x: 20, y: 150 }, {}, DISP)!;
  assert(boxNear(wOut, [100, 100, 400, 200]) && boxNear(wOut.crop, [0, 50, 400, 200]), "W outward clamps at crop.x = 0");
  // uncrop fully on one axis then keep dragging — no overshoot past content
  const nOut = cropRemap(el, "n", { x: 300, y: -500 }, {}, DISP)!;
  assert(near(nOut.crop.y, 0) && near(nOut.y, 50), "N outward clamps at crop.y = 0 (box top = content top)");
}

// ---------------------------------------------------------------------------
// 4) minimum window: ≥ max(1 intrinsic px, 1 canvas px)
// ---------------------------------------------------------------------------
{
  const el = mkPlot(); // kx = 1 → min 1 px both ways
  const tiny = cropRemap(el, "e", { x: -100, y: 300 }, {}, DISP)!;
  assert(near(tiny.width, 1) && near(tiny.crop.width, 1) && near(tiny.x, 40), "E drag past the far edge floors at 1 px (anchor edge holds)");
  const half = mkPlot({ width: 336, height: 240 }); // kx = 0.5 → min 1 CANVAS px = 2 content px
  const t2 = cropRemap(half, "e", { x: -100, y: 100 }, {}, DISP)!;
  assert(near(t2.width, 1) && near(t2.crop.width, 2), "min window respects 1 canvas px when kx < 1 (2 intrinsic px)");
  const dbl = mkPlot({ width: 1344, height: 960 }); // kx = 2 → min 1 INTRINSIC px = 2 canvas px
  const t3 = cropRemap(dbl, "e", { x: -100, y: 100 }, {}, DISP)!;
  assert(near(t3.width, 2) && near(t3.crop.width, 1), "min window respects 1 intrinsic px when kx > 1");
}

// ---------------------------------------------------------------------------
// 5) rotation: pointer inverse-rotates into the unrotated frame
// ---------------------------------------------------------------------------
{
  const rot = 30;
  const el = mkPlot({ rotation: rot });
  const c = { x: 40 + 336, y: 40 + 240 };
  const q = { x: 512, y: 280 }; // the unrotated-frame target (same as an E drag)
  const rad = (rot * Math.PI) / 180;
  const p = {
    x: c.x + (q.x - c.x) * Math.cos(rad) - (q.y - c.y) * Math.sin(rad),
    y: c.y + (q.x - c.x) * Math.sin(rad) + (q.y - c.y) * Math.cos(rad),
  };
  const r = cropRemap(el, "e", p, {}, DISP)!;
  const flat = cropRemap(mkPlot(), "e", q, {}, DISP)!;
  assert(
    boxNear(r, [flat.x, flat.y, flat.width, flat.height], 1e-6) && boxNear(r.crop, [flat.crop.x, flat.crop.y, flat.crop.width, flat.crop.height], 1e-6),
    "rotated 30°: a pointer at the rotated image of the target reproduces the unrotated result",
  );
}

// ---------------------------------------------------------------------------
// 6) flip: the box follows the pointer; the read-back eats the mirrored side
// ---------------------------------------------------------------------------
{
  const el = mkPlot({ flipX: true });
  const r = cropRemap(el, "e", { x: 512, y: 300 }, {}, DISP)!;
  assert(boxNear(r, [40, 40, 472, 480]), "flipX + E drag: the box right edge follows the pointer (no detach)");
  assert(boxNear(r.crop, [200, 0, 472, 480]), "flipX + E drag: crops the LOW-content-x side (renders on the right)");
  const l = cropRemap(el, "w", { x: 140, y: 300 }, {}, DISP)!;
  assert(boxNear(l, [140, 40, 572, 480]) && boxNear(l.crop, [0, 0, 572, 480]), "flipX + W drag: crops the high-content-x side");

  const fy = mkPlot({ flipY: true });
  const b = cropRemap(fy, "s", { x: 300, y: 400 }, {}, DISP)!;
  assert(boxNear(b, [40, 40, 672, 360]) && boxNear(b.crop, [0, 120, 672, 360]), "flipY + S drag: crops the low-content-y side");
}

// ---------------------------------------------------------------------------
// 7) Shift (aspect) + Alt (symmetric) + Shift+Alt
// ---------------------------------------------------------------------------
{
  const el = mkPlot(); // aspect 672/480 = 1.4, centre (376, 280)
  const se = cropRemap(el, "se", { x: 512, y: 460 }, { shift: true }, DISP)!;
  assert(near(se.width / se.height, 672 / 480) && boxNear(se, [40, 40, 588, 420]), "Shift+SE keeps the box aspect (dominant ratio wins)");
  assert(boxNear(se.crop, [0, 0, 588, 420]), "Shift: crop keeps the same window as the box");

  const alt = cropRemap(el, "e", { x: 512, y: 300 }, { alt: true }, DISP)!;
  assert(boxNear(alt, [240, 40, 272, 480]) && boxNear(alt.crop, [200, 0, 272, 480]), "Alt+E crops symmetrically about the centre");

  const both = cropRemap(el, "se", { x: 512, y: 400 }, { shift: true, alt: true }, DISP)!;
  assert(
    boxNear(both, [208, 160, 336, 240]) && boxNear(both.crop, [168, 120, 336, 240]),
    "Shift+Alt+SE: aspect about the centre",
  );
}

// ---------------------------------------------------------------------------
// 8) guards
// ---------------------------------------------------------------------------
{
  const text = { type: "text", id: "t", x: 0, y: 0, width: 10, height: 10, rotation: 0 } as unknown as Element;
  assert(cropRemap(text, "e", { x: 5, y: 5 }, {}, DISP) === null, "non-croppable element type → null");
  assert(cropRemap(mkPlot(), "e", { x: 5, y: 5 }, {}, { width: 0, height: 480 }) === null, "degenerate disp → null");
  assert(cropRemap(mkPlot({ width: 0 }), "e", { x: 5, y: 5 }, {}, DISP) === null, "degenerate element box → null");
}

// ---------------------------------------------------------------------------
// 9) ops.setCrop: content-pinned set / normalize / reset round-trip
// ---------------------------------------------------------------------------
function mkProject(el: SemanticPlotElement | ImageElement, asset: Partial<Project["assets"][0]> = {}): Project {
  return {
    version: 2,
    name: "t",
    canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 2000, height: 2000, background: "#fff", elements: [el] }],
    assets: [
      { id: "a1", name: "a", kind: "svg", path: "assets/a1.svg", naturalWidth: 672, naturalHeight: 480, ...asset },
    ],
    palette: [],
  };
}
const getEl = (p: Project) => p.figures[0].elements[0] as SemanticPlotElement;

{
  const p = mkProject(mkPlot());
  assert(ops.setCrop(p, "p1", { x: 100, y: 60, width: 300, height: 200 }), "setCrop returns true on a hit");
  const e = getEl(p);
  assert(boxNear(e, [140, 100, 300, 200]) && boxNear(e.crop!, [100, 60, 300, 200]), "setCrop: box moves to frame the window (content pinned)");

  // reset round-trips back to the original box
  ops.setCrop(p, "p1", null);
  const r = getEl(p);
  assert(boxNear(r, [40, 40, 672, 480]) && r.crop === undefined, "setCrop(null) restores the original full-content box (round-trip)");

  // full-window crop normalizes to "no crop"
  ops.setCrop(p, "p1", { x: 50, y: 0, width: 200, height: 480 });
  ops.setCrop(p, "p1", { x: 0, y: 0, width: 672, height: 480 });
  const f = getEl(p);
  assert(f.crop === undefined && boxNear(f, [40, 40, 672, 480]), "a full-content window is normalized to no crop (+ full box)");

  // out-of-bounds input is clamped
  ops.setCrop(p, "p1", { x: -50, y: 10, width: 9999, height: 100 });
  const c = getEl(p);
  assert(boxNear(c.crop!, [0, 10, 672, 100]), "setCrop clamps the window into the content");

  // no-op reset
  ops.setCrop(p, "p1", null);
  ops.setCrop(p, "p1", null);
  assert(getEl(p).crop === undefined, "setCrop(null) on an uncropped element is a no-op");

  assert(!ops.setCrop(p, "nope", null), "setCrop returns false for an unknown id");
}

{
  // cropRemap → commit (as the gesture does) → reset round-trip
  const el = mkPlot();
  const res = cropRemap(el, "w", { x: 140, y: 300 }, {}, DISP)!;
  const p = mkProject(mkPlot());
  ops.setCrop(p, "p1", res.crop);
  const e = getEl(p);
  assert(boxNear(e, [res.x, res.y, res.width, res.height], 1e-6), "gesture commit path: setCrop(res.crop) reproduces cropRemap's box exactly");
  ops.setCrop(p, "p1", null);
  assert(boxNear(getEl(p), [40, 40, 672, 480], 1e-6), "…and reset returns to the pre-crop box");
}

{
  // flip-aware setCrop: reset keeps the mirrored content pinned
  const el = mkPlot({ flipX: true });
  const res = cropRemap(el, "e", { x: 512, y: 300 }, {}, DISP)!;
  const p = mkProject({ ...mkPlot({ flipX: true }), ...{ x: res.x, y: res.y, width: res.width, height: res.height, crop: res.crop } });
  ops.setCrop(p, "p1", null);
  assert(boxNear(getEl(p), [40, 40, 672, 480], 1e-6), "flipX: setCrop(null) round-trips to the original box");
}

{
  // PNG dpi: crop coords live in DISPLAY px (natural × 96/dpi)
  const img: ImageElement = { type: "image", id: "p1", x: 0, y: 0, width: 320, height: 160, rotation: 0, assetId: "a1" };
  const p = mkProject(img, { kind: "png", naturalWidth: 1000, naturalHeight: 500, dpi: 300 });
  // display size = 1000×96/300 = 320 × 160 → element at true size, kx = 1
  ops.setCrop(p, "p1", { x: 20, y: 10, width: 100, height: 50 });
  const e = p.figures[0].elements[0] as ImageElement;
  assert(boxNear(e, [20, 10, 100, 50]) && boxNear(e.crop!, [20, 10, 100, 50]), "PNG dpi: crop in assetDisplaySize units maps 1:1 at true size");
}

console.log(fails === 0 ? "\nVERIFY-CROP-MATH ALL PASS" : `\nVERIFY-CROP-MATH ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
