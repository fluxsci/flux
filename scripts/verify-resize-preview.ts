#!/usr/bin/env -S node --import tsx
// Resize preview transform (perf 2026-09-30) — the pure contract of
// `src/lib/interact/resizePreview.ts resizePreviewTransform`: during a resize, a plot's LIVE scene
// group carries a CSS transform instead of an overlay copy re-mounted per pointermove. That transform
// applied to the element's rendering at its ORIGINAL box must equal the rendering at the REMAPPED box
// (the exact geometry the release commit renders, pt-true aside), for:
//   • plain resize from every handle, including past-the-anchor drags;
//   • cardinal rotations (90/180/270, axes swap) and oblique rotations (uniform scale only);
//   • flipX / flipY, combined with rotations;
//   • the Scale tool (K) remap and multi-selection sub-boxes;
//   • degenerate boxes → null (the caller then keeps the element untransformed).
// Rendering = Element.svelte's transform (rotate about the bbox centre, then flip about it) ∘ the
// plot's box mapping (unit square → x,y,width,height with preserveAspectRatio="none").
//   Run: node --import tsx scripts/verify-resize-preview.ts
import { resizePreviewTransform, transientResizeKind } from "../src/lib/interact/resizePreview";
import { resizeRemap, scaleRemap } from "../src/lib/editing";
import { elementBBox, selectionBBox, type Rect } from "../src/lib/geometry";
import type { Element } from "../src/lib/types";

type M = [number, number, number, number, number, number]; // a b c d e f (SVG/CSS 2D)
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const T = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const S = (x: number, y: number): M => [x, 0, 0, y, 0, 0];
const R = (deg: number): M => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
const chain = (...ms: M[]) => ms.reduce((a, b) => mul(a, b), [1, 0, 0, 1, 0, 0] as M);

/** Parse the CSS transform list resizePreviewTransform emits. */
function parseCss(css: string): M {
  const ms: M[] = [];
  for (const [, fn, args] of css.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const v = args.split(",").map((s) => parseFloat(s));
    if (fn === "translate") ms.push(T(v[0], v[1] ?? 0));
    else if (fn === "scale") ms.push(S(v[0], v[1] ?? v[0]));
    else if (fn === "rotate") ms.push(R(v[0]));
    else throw new Error("unexpected transform fn " + fn);
  }
  return chain(...ms);
}
/** Element.svelte's rendering of a box element: rotate(θ, c) · flip about c · unit square → box. */
function rendering(e: Element): M {
  const b = elementBBox(e);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return chain(
    T(cx, cy), R(e.rotation ?? 0), S(e.flipX ? -1 : 1, e.flipY ? -1 : 1), T(-cx, -cy),
    T(b.x, b.y), S(b.w, b.h),
  );
}

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("  ✗ " + m); } };
const near = (p: M, q: M) => p.every((v, i) => Math.abs(v - q[i]) < 1e-4);

const plot = (over: Partial<Element> = {}): Element =>
  ({ type: "plot", id: "p", assetId: "a", x: 40, y: 30, width: 200, height: 120, rotation: 0, ...over }) as unknown as Element;

function check(label: string, orig: Element, ob: Rect, nb: Rect, scale = false) {
  const next = structuredClone(orig);
  if (scale) scaleRemap(next, orig, ob, nb); else resizeRemap(next, orig, ob, nb);
  const css = resizePreviewTransform(orig, next);
  ok(css !== null, `${label}: transform produced`);
  if (!css) return;
  const got = chain(parseCss(css), rendering(orig));
  ok(near(got, rendering(next)), `${label}: preview == committed rendering\n    got ${got.map((v) => v.toFixed(4))}\n    want ${rendering(next).map((v) => v.toFixed(4))}`);
}

console.log("plain resize, every handle-ish box change:");
const base = plot();
const ob = selectionBBox([base])!;
for (const nb of [
  { x: ob.x, y: ob.y, w: ob.w * 1.7, h: ob.h * 1.3 },          // SE grow
  { x: ob.x + 50, y: ob.y, w: ob.w - 50, h: ob.h },             // W shrink
  { x: ob.x, y: ob.y - 20, w: ob.w, h: ob.h + 20 },             // N grow
  { x: ob.x, y: ob.y, w: 3, h: 2 },                            // tiny
]) check(`box ${JSON.stringify(nb)}`, base, ob, nb);

console.log("cardinal + oblique rotations, flips:");
for (const rotation of [90, 180, 270, -90]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
  const e = plot({ rotation, flipX, flipY } as Partial<Element>);
  const b = selectionBBox([e])!;
  check(`rot ${rotation} flip ${+flipX}${+flipY}`, e, b, { x: b.x - 10, y: b.y + 5, w: b.w * 1.4, h: b.h * 0.7 });
}
for (const rotation of [30, -47.5]) for (const flipX of [false, true]) {
  const e = plot({ rotation, flipX } as Partial<Element>);
  const b = selectionBBox([e])!;
  check(`oblique rot ${rotation} flipX ${flipX} (uniform)`, e, b, { x: b.x, y: b.y, w: b.w * 1.25, h: b.h * 1.25 });
}

console.log("Scale tool (K) and a multi-selection member:");
check("K uniform", base, ob, { x: ob.x, y: ob.y, w: ob.w * 0.6, h: ob.h * 0.6 }, true);
{
  const other = plot({ id: "q", x: 400, y: 200, width: 80, height: 60 } as Partial<Element>);
  const sel = selectionBBox([base, other])!;
  const nb = { x: sel.x - 30, y: sel.y, w: sel.w * 1.2, h: sel.h * 0.9 };
  check("multi member A", base, sel, nb);
  check("multi member B", other, sel, nb);
}

console.log("degenerate + kinds:");
ok(resizePreviewTransform(plot({ width: 0 } as Partial<Element>), plot()) === null, "zero-width original → null");
ok(transientResizeKind(plot()) && !transientResizeKind({ type: "rect" } as Element) && !transientResizeKind({ type: "text" } as Element), "only plots take the transient path");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
