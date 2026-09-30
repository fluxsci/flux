// ---------------------------------------------------------------------------
// Flux Slide — the TRANSFORM tween core (animation rework §4.2). Pure and
// DOM-free by contract: flux-core, the GUI, and the export runtime all load
// this one module — the parity keystone of the transform feature.
//
// Three verbs over the figure Element union:
//   applyState(el, state)  — ⊕: the sparse-patch application (t2 = pre ⊕ state)
//   diffState(pre, cur)    — sparse capture (what the endpoint checkout writes)
//   lerpElement(pre, end, t) — the interpolator (what the player drives)
//
// The interpolation intelligence is deliberately OURS (no user knobs beyond
// timing/easing): numerics lerp, colors blend in OKLab, path geometry
// resamples by arc length, text with a single differing number digit-tweens,
// everything non-interpolable steps at t = 0.5 (predictable, never garbage).
// Content the DRIVER should crossfade instead (text rewrites, closed≠open
// paths, incompatible plots) is reported by contentPlan().
// ---------------------------------------------------------------------------

import { isHandoff } from "./targets";
import type { ColorScaleView, ColorScaleTable, Element, SemanticPlotElement, PartOverride, PlotView, VectorNode } from "../types";
import { effectiveScale } from "../plot/colorscale";
import { colormapLut } from "../color/colormapLuts";
import type { FluxPlotManifest } from "../plot/types";
import type { Slide } from "./types";
import { familyOf } from "./family";
import { lerpColor } from "../color/interp";
import { elementBBox } from "../geometry";
import { pathD, pathToNodes, resampleNodes } from "../path";
import { outlineMorphable, planElementMorph, sampleElementMorph } from "./outline";
import { compileSlide } from "./compile";
import { planHandoff } from "./handoffPlan";
import type { GeometryCtx } from "./targetGeometry";
import type { ModelFieldOverride } from "../model3d/types";

// --- the property law --------------------------------------------------------

/** Props never captured into a transform state (identity/bookkeeping/derived).
 *  `assetId` is here too: a plot's content target lives in `to.assetId` (the
 *  content half), never in the state patch. `type` IS captured: a Become
 *  records the kind the object turns into (applyState retypes — below). */
const NEVER_CAPTURED = new Set([
  "id", "name", "groupId", "locked", "hidden", "lockAspect",
  "assetId", "styleId", "panelLabel", "lines", "needsLayout",
  "source", "manifestRef", "posterAssetId", "durationMs", "muted", "loop",
]);

/** The props every kind shares — what survives a RETYPE (a patch whose `type`
 *  differs from the element's). Everything else of the old kind is dropped so
 *  a line that became an ellipse carries no stray endpoints. */
const BASE_PROPS = new Set([
  "id", "name", "groupId", "locked", "hidden", "lockAspect",
  "x", "y", "width", "height", "rotation", "flipX", "flipY", "opacity",
]);

/** Minimum props a retyped element needs to render/edit when the patch left
 *  them out (agent-authored `{type}`-only patches); a GUI Become always
 *  supplies the target's complete state. */
function completeRetyped(el: Record<string, unknown>): void {
  const def = (k: string, v: unknown) => { if (el[k] === undefined) el[k] = v; };
  switch (el.type) {
    case "rect": def("fill", "none"); def("stroke", "#000000"); def("strokeWidth", 1); def("cornerRadius", 0); break;
    case "ellipse": def("fill", "none"); def("stroke", "#000000"); def("strokeWidth", 1); break;
    case "line":
      def("x1", 0); def("y1", 0); def("x2", el.width ?? 0); def("y2", el.height ?? 0);
      def("stroke", "#000000"); def("strokeWidth", 1); def("arrowStart", false); def("arrowEnd", false);
      break;
    case "path": {
      def("fill", "none"); def("stroke", "#000000"); def("strokeWidth", 1); def("closed", false);
      const nodes = el.nodes as VectorNode[] | undefined;
      if (typeof el.d !== "string") el.d = nodes?.length ? pathD(nodes, Boolean(el.closed), el.cornerRadius as number | undefined) : "";
      break;
    }
    case "text":
      def("text", ""); def("fontFamily", "sans-serif"); def("fontSize", 16); def("fontWeight", 400);
      def("fontStyle", "normal"); def("align", "left"); def("color", "#000000"); def("sizing", "auto");
      break;
    case "plot": case "image": def("assetId", ""); break; // the content half (to.assetId) names the asset
    case "model3d":
      def("assetId", ""); def("orbitAzimuth", 30); def("orbitElevation", 20);
      def("orbitZoom", 1); def("orbitProjection", "orthographic"); def("orbitFov", 30);
      def("fill", "#4385be"); def("modelColors", "source"); def("modelLighting", "studio");
      break;
  }
}

/** Scalar-lerp props (rotation is special-cased for shortest arc). */
const NUM_PROPS = new Set([
  "x", "y", "width", "height", "opacity", "strokeWidth", "fontSize",
  "cornerRadius", "lineHeight", "letterSpacing", "paragraphSpacing",
  "x1", "y1", "x2", "y2", "contentScale",
  "arrowSize",
  "orbitAzimuth", "orbitElevation", "orbitRoll", "orbitPanX", "orbitPanY", "orbitFov",
]);

/** OKLab-lerp props. */
const COLOR_PROPS = new Set(["fill", "stroke", "color"]);

/** Text props whose change invalidates the wrap cache (`lines`). */
const METRIC_PROPS = new Set([
  "text", "fontSize", "fontFamily", "fontWeight", "fontStyle", "width",
  "sizing", "lineHeight", "underline", "letterSpacing", "paragraphSpacing",
  // Per-range formatting is a metric too: a bolded word re-wraps the line.
  "runs",
]);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRot = (a: number, b: number, t: number) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;
const step = <T,>(a: T, b: T, t: number): T => (t < 0.5 ? a : b);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- applyState (⊕) ----------------------------------------------------------

/** Apply a sparse transform patch to an element: shallow per top-level prop
 *  (`null` deletes), with `overrides` merging PER PART-ID (a part key of
 *  `null` deletes that part; a present part replaces its override object
 *  verbatim — exactly what diffState records). Returns a fresh clone; the
 *  input is never mutated. Text whose metric props changed drops its derived
 *  wrap cache and flags `needsLayout` (the GUI reflows; headless warns). */
export function applyState(el: Element, state: Record<string, unknown> | undefined | null): Element {
  let out = structuredClone(el) as unknown as Record<string, unknown>;
  if (!state) return out as unknown as Element;
  // A patch naming another KIND retypes: keep the shared base props, take
  // the rest from the patch (nothing of the old kind lingers).
  const retype = typeof state.type === "string" && state.type !== el.type;
  if (retype) {
    const kept: Record<string, unknown> = {};
    for (const k of BASE_PROPS) if (k in out) kept[k] = out[k];
    out = kept;
  }
  let metrics = false;
  for (const [k, v] of Object.entries(state)) {
    if (NEVER_CAPTURED.has(k)) continue;
    if (k === "type") { if (retype) out.type = v; continue; }
    if (k === "overrides") {
      const merged: Record<string, PartOverride> = { ...((out.overrides as Record<string, PartOverride>) ?? {}) };
      if (isObj(v)) {
        for (const [part, patch] of Object.entries(v)) {
          if (patch === null) delete merged[part];
          else merged[part] = structuredClone(patch) as PartOverride;
        }
      }
      if (Object.keys(merged).length) out.overrides = merged;
      else delete out.overrides;
      continue;
    }
    if (v === null) delete out[k];
    else out[k] = structuredClone(v);
    if (METRIC_PROPS.has(k)) metrics = true;
  }
  if (retype) completeRetyped(out);
  if (metrics && (out.type === "text")) {
    delete out.lines;
    delete (out as { lineWidths?: number[] }).lineWidths;
    out.needsLayout = true;
  }
  // keep the path's render form in sync with patched authoritative nodes
  // (pathD embeds the cornerRadius fillets — a patched radius re-emits too)
  if (out.type === "path" && ("nodes" in state || "closed" in state || "cornerRadius" in state)) {
    const nodes = out.nodes as VectorNode[] | undefined;
    if (nodes?.length) out.d = pathD(nodes, Boolean(out.closed), out.cornerRadius as number | undefined);
  }
  return out as unknown as Element;
}

// --- diffState ----------------------------------------------------------------

function eq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && a !== null && b !== null) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Sparse capture: the patch that turns `pre` into `cur` (applyState-exact:
 *  applyState(pre, diffState(pre, cur)) ≡ cur up to NEVER_CAPTURED props).
 *  Returns null when nothing captured changed. */
export function diffState(pre: Element, cur: Element): Record<string, unknown> | null {
  const a = pre as unknown as Record<string, unknown>;
  const b = cur as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  // across kinds the retype already drops the old kind's props — no nulls needed
  const retype = pre.type !== cur.type;
  for (const k of keys) {
    if (NEVER_CAPTURED.has(k)) continue;
    if (k === "type") { if (retype) out.type = cur.type; continue; }
    if (k === "overrides") {
      const ova = (a.overrides as Record<string, PartOverride>) ?? {};
      const ovb = (b.overrides as Record<string, PartOverride>) ?? {};
      const parts: Record<string, PartOverride | null> = {};
      for (const part of new Set([...Object.keys(ova), ...Object.keys(ovb)])) {
        if (!(part in ovb)) parts[part] = null;
        else if (!eq(ova[part], ovb[part])) parts[part] = structuredClone(ovb[part]);
      }
      if (Object.keys(parts).length) out.overrides = parts;
      continue;
    }
    if (!(k in b)) {
      if (k in a && (!retype || BASE_PROPS.has(k))) out[k] = null;
    } else if (!eq(a[k], b[k]) || (retype && !BASE_PROPS.has(k))) {
      out[k] = structuredClone(b[k]);
    }
  }
  return Object.keys(out).length ? out : null;
}

// --- text: the numeric digit-tween -------------------------------------------

/** If two texts differ ONLY in one number run (same prefix + suffix), return a
 *  sampler producing the digit-tween text at t (countUp-style format
 *  inference: decimals + thousands separators from the endpoints). Otherwise
 *  null (the driver crossfades). */
export function numericTextTween(preText: string, endText: string): ((t: number) => string) | null {
  if (preText === endText) return null;
  const NUM = /-?\d[\d,]*(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  const ma = NUM.exec(preText);
  const mb = NUM.exec(endText);
  if (!ma || !mb) return null;
  const preA = preText.slice(0, ma.index), sufA = preText.slice(ma.index + ma[0].length);
  const preB = endText.slice(0, mb.index), sufB = endText.slice(mb.index + mb[0].length);
  if (preA !== preB || sufA !== sufB) return null;
  const va = Number(ma[0].replace(/,/g, ""));
  const vb = Number(mb[0].replace(/,/g, ""));
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return null;
  const decimals = Math.max(
    ma[0].includes(".") ? (ma[0].split(".")[1]?.length ?? 0) : 0,
    mb[0].includes(".") ? (mb[0].split(".")[1]?.length ?? 0) : 0,
  );
  const separator = ma[0].includes(",") || mb[0].includes(",");
  const fmt = (v: number): string => {
    let s = v.toFixed(decimals);
    if (separator) {
      const [i, d] = s.split(".");
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
    }
    return preA + s + sufA;
  };
  return (t: number) => (t <= 0 ? preText : t >= 1 ? endText : fmt(va + (vb - va) * t));
}

// --- geometry -----------------------------------------------------------------

function nodesOf(el: { nodes?: VectorNode[]; d: string }): VectorNode[] {
  return el.nodes?.length ? el.nodes : pathToNodes(el.d);
}

function lerpHandle(
  a: { dx: number; dy: number } | undefined,
  b: { dx: number; dy: number } | undefined,
  t: number,
): { dx: number; dy: number } | undefined {
  if (!a && !b) return undefined;
  const ax = a?.dx ?? 0, ay = a?.dy ?? 0, bx = b?.dx ?? 0, by = b?.dy ?? 0;
  return { dx: lerp(ax, bx, t), dy: lerp(ay, by, t) };
}

/** Tween two node lists (same closedness). Unequal counts arc-length-resample
 *  BOTH to the larger count (geometry-preserving), then lerp positions +
 *  handles; node type follows the END side's classification intent (corner —
 *  types are editing metadata, not render state). */
export function lerpNodes(a: VectorNode[], b: VectorNode[], closed: boolean, t: number): VectorNode[] {
  let na = a, nb = b;
  if (a.length !== b.length) {
    const n = Math.max(a.length, b.length, closed ? 3 : 2);
    na = resampleNodes(a, closed, n);
    nb = resampleNodes(b, closed, n);
  }
  const len = Math.min(na.length, nb.length);
  const out: VectorNode[] = [];
  for (let i = 0; i < len; i++) {
    const pa = na[i], pb = nb[i];
    const node: VectorNode = { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), type: pb.type };
    const hIn = lerpHandle(pa.hIn, pb.hIn, t);
    const hOut = lerpHandle(pa.hOut, pb.hOut, t);
    if (hIn) node.hIn = hIn;
    if (hOut) node.hOut = hOut;
    out.push(node);
  }
  return out;
}

// --- dash ---------------------------------------------------------------------

/** Tween dash patterns. Absent/empty = solid, represented as the other side's
 *  pattern with zero GAPS (so dashes fade in/out smoothly rather than pop).
 *  Odd-length patterns are doubled first (SVG's own repeat rule), then both
 *  are padded by repetition to a common length and lerped elementwise. */
export function lerpDash(a: number[] | undefined, b: number[] | undefined, t: number, out: number[] = []): number[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  if (t <= 0 || t >= 1) {
    const d = t <= 0 ? a : b;
    if (!d) return undefined;
    for (let i = 0; i < d.length; i++) out[i] = d[i];
    out.length = d.length;
    return out;
  }
  const da = a?.length ? a : b!, db = b?.length ? b : a!;
  const n = Math.max(da.length * (da.length % 2 ? 2 : 1), db.length * (db.length % 2 ? 2 : 1));
  for (let i = 0; i < n; i++) {
    const va = !a?.length && i % 2 ? 0 : da[i % da.length];
    const vb = !b?.length && i % 2 ? 0 : db[i % db.length];
    out[i] = Math.max(0, lerp(va, vb, t));
  }
  out.length = n;
  return out;
}

// --- the content plan (what the driver renders) -------------------------------

export type ContentMode = "tween" | "crossfade" | "morph" | "model-live";

export interface ContentPlan {
  /** How the CONTENT layer animates ("tween": one re-rendered layer;
   *  "crossfade": two stacked layers, opacity cross-lerped — geometry still
   *  moves via the lerped box; "morph": one live outline path between two
   *  drawn kinds — see outline.ts). */
  mode: ContentMode;
  /** Text digit-tween sampler when the text change is a pure numeric diff. */
  textTween?: (t: number) => string;
  /** Any prop outside {x,y,rotation,opacity,flips} changed — the driver must
   *  re-render content per frame (box-only transforms skip that entirely). */
  contentDirty: boolean;
  /** Geometry-affecting props changed (dash-residue clearing rule). */
  geometryDirty: boolean;
}

const BOX_ONLY = new Set(["x", "y", "rotation", "opacity", "flipX", "flipY"]);
const GEOM_PROPS = new Set([
  "width", "height", "d", "nodes", "closed", "x1", "y1", "x2", "y2",
  "cornerRadius", "crop", "contentScale", "view",
]);

/** Decide how the driver animates the content between two states of one
 *  element (same id/type by construction). */
export function contentPlan(pre: Element, end: Element): ContentPlan {
  const changed = diffState(pre, end) ?? {};
  const keys = Object.keys(changed);
  const contentDirty = keys.some((k) => !BOX_ONLY.has(k));
  const geometryDirty = keys.some((k) => GEOM_PROPS.has(k));
  let mode: ContentMode = "tween";
  let textTween: ((t: number) => string) | undefined;
  if (pre.type === "text" && end.type === "text" && pre.text !== end.text) {
    const sampler = numericTextTween(pre.text, end.text);
    if (sampler) textTween = sampler;
    else mode = "crossfade";
  }
  // Across kinds: drawn kinds morph through one outline (a path whose
  // closedness changes is the same topology change); everything else
  // (text, images, plots, video) crossfades while the box still tweens.
  if (outlineMorphable(pre, end)) mode = "morph";
  else if (pre.type !== end.type) mode = "crossfade";
  else if (pre.type === "model3d" && end.type === "model3d") mode = "model-live";
  return { mode, ...(textTween ? { textTween } : {}), contentDirty: mode === "model-live" ? false : contentDirty, geometryDirty };
}

// --- lerpElement --------------------------------------------------------------

/** Only physical box channels extrapolate; the clamped content stays intact. */
export function overshootBox(el: Element, pre: Element, end: Element, u: number): Element {
  if (u >= 0 && u <= 1) return el;
  const out = { ...el,
    x: lerp(pre.x, end.x, u), y: lerp(pre.y, end.y, u),
    width: Math.max(0, lerp(pre.width, end.width, u)),
    height: Math.max(0, lerp(pre.height, end.height, u)),
    rotation: lerpRot(pre.rotation ?? 0, end.rotation ?? 0, u),
  };
  if ("contentScale" in pre || "contentScale" in end) {
    (out as SemanticPlotElement).contentScale = Math.max(.01, lerp(
      (pre as SemanticPlotElement).contentScale ?? 1, (end as SemanticPlotElement).contentScale ?? 1, u));
  }
  return out;
}

/** Bend a sampled box about the midpoint, with control offset arc·distance/2.
 * Mutates only the owned sample's x/y; endpoints and arc 0 are byte-identical. */
export function arcBox(el: Element, pre: Element, end: Element, u: number, arc = 0): Element {
  if (!arc || u === 0 || u === 1) return el;
  const bend = arc * u * (1 - u);
  el.x = lerp(pre.x, end.x, u) - (end.y - pre.y) * bend;
  el.y = lerp(pre.y, end.y, u) + (end.x - pre.x) * bend;
  return el;
}

/** Interpolate two states of ONE element (same id/type). raw≤0 / raw≥1 return
 *  clones of the endpoints verbatim (true end nodes, no resample residue).
 *  Non-interpolable props step at raw progress = 0.5. */
export function lerpElement(pre: Element, end: Element, t: number, raw = t): Element {
  if (raw <= 0) return structuredClone(pre);
  if (raw >= 1) return structuredClone(end);
  // Across kinds (or a path changing closedness): the outline morph — one
  // synthetic path mid-flight. Kinds without an outline step their content
  // at t = 0.5 while box/rotation/opacity still tween (the driver crossfades).
  if (outlineMorphable(pre, end)) {
    const plan = planElementMorph(pre, end);
    if (plan) return sampleElementMorph(plan, t, raw);
  }
  if (pre.type !== end.type) return lerpAcrossKinds(pre, end, t, raw);
  const a = pre as unknown as Record<string, unknown>;
  const b = end as unknown as Record<string, unknown>;
  const out = structuredClone(b); // end's shape; every differing prop overwritten below
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let metrics = false;
  for (const k of keys) {
    const va = a[k], vb = b[k];
    if (eq(va, vb)) continue;
    if (METRIC_PROPS.has(k)) metrics = true;
    // one-sided props: numerics default sensibly, everything else steps
    if (k === "rotation") {
      out[k] = lerpRot(Number(va ?? 0), Number(vb ?? 0), t);
    } else if (k === "opacity") {
      out[k] = lerp(Number(va ?? 1), Number(vb ?? 1), t);
    } else if (k === "orbitZoom") {
      out[k] = Math.exp(lerp(Math.log(Number(va ?? 1)), Math.log(Number(vb ?? 1)), t));
    } else if (k === "fields") {
      out[k] = lerpFields(va as Record<string, ModelFieldOverride> | undefined, vb as Record<string, ModelFieldOverride> | undefined, t, raw);
      if (!Object.keys(out[k] as object).length) delete out[k];
    } else if (k === "modelStates") {
      out[k] = lerpStates(va as Record<string, number> | undefined, vb as Record<string, number> | undefined, t);
      if (!Object.keys(out[k] as object).length) delete out[k];
    } else if (NUM_PROPS.has(k) && (typeof va === "number" || typeof vb === "number")) {
      const fa = typeof va === "number" ? va : k === "contentScale" ? 1 : 0;
      const fb = typeof vb === "number" ? vb : k === "contentScale" ? 1 : 0;
      out[k] = lerp(fa, fb, t);
    } else if (COLOR_PROPS.has(k) && typeof va === "string" && typeof vb === "string") {
      out[k] = lerpColor(va, vb, t, undefined, raw);
    } else if (k === "dash") {
      const d = lerpDash(va as number[] | undefined, vb as number[] | undefined, t);
      if (d) out[k] = d;
      else delete out[k];
    } else if (k === "crop") {
      if (isObj(va) && isObj(vb)) {
        out[k] = {
          x: lerp(Number(va.x), Number(vb.x), t),
          y: lerp(Number(va.y), Number(vb.y), t),
          width: lerp(Number(va.width), Number(vb.width), t),
          height: lerp(Number(va.height), Number(vb.height), t),
        };
      } else {
        if (step(va, vb, raw) === undefined) delete out[k];
        else out[k] = structuredClone(step(va, vb, raw));
      }
    } else if (k === "view") {
      const view = lerpView(va as PlotView | undefined, vb as PlotView | undefined, t, raw);
      if (view) out[k] = view; else delete out[k];
    } else if (k === "colorScale") {
      const scales = lerpColorScales(va as Record<string, ColorScaleView> | undefined, vb as Record<string, ColorScaleView> | undefined, t, raw);
      if (scales) out[k] = scales; else delete out[k];
    } else if (k === "overrides") {
      out[k] = lerpOverrides(va as Record<string, PartOverride> | undefined, vb as Record<string, PartOverride> | undefined, t, raw);
      if (!Object.keys(out[k] as object).length) delete out[k];
    } else if (k === "nodes" || k === "d" || k === "closed") {
      continue; // path geometry handled wholesale below
    } else if (k === "text" && typeof va === "string" && typeof vb === "string") {
      const sampler = numericTextTween(va, vb);
      out[k] = sampler ? sampler(t) : step(va, vb, raw);
    } else if (k === "fontWeight") {
      out[k] = Math.round(lerp(Number(va ?? 400), Number(vb ?? 400), t) / 100) * 100;
    } else {
      // discrete (booleans, align, fontFamily, sizing, arrow flags, cap, …)
      const v = step(va, vb, raw);
      if (v === undefined) delete out[k];
      else out[k] = structuredClone(v);
    }
  }
  // path geometry, wholesale (same closedness — a closedness change morphed above)
  if (pre.type === "path" && end.type === "path") {
    const closedB = Boolean(end.closed);
    if (pre.d !== end.d || JSON.stringify(pre.nodes) !== JSON.stringify(end.nodes)) {
      const nodes = lerpNodes(nodesOf(pre), nodesOf(end), closedB, t);
      (out as unknown as { nodes: VectorNode[]; d: string; closed: boolean }).nodes = nodes;
      // cornerRadius was already lerped above (NUM_PROPS) — the frame's d
      // fillets with the interpolated radius over the interpolated skeleton.
      (out as unknown as { d: string }).d = pathD(nodes, closedB, (out as { cornerRadius?: number }).cornerRadius);
    }
  }
  if (metrics && out.type === "text") {
    delete (out as unknown as { lines?: string[]; lineWidths?: number[] }).lines;
    delete (out as unknown as { lineWidths?: number[] }).lineWidths;
    (out as unknown as { needsLayout?: true }).needsLayout = true;
  }
  return out as unknown as Element;
}

/** Two kinds with no shared outline (a text becoming a plot, an image becoming
 *  a rect…): the content steps at t = 0.5, the shared base tweens. The driver
 *  renders this as a crossfade over the lerped box. */
function lerpAcrossKinds(pre: Element, end: Element, t: number, raw: number): Element {
  const src = raw < 0.5 ? pre : end;
  const out = structuredClone(src) as unknown as Record<string, unknown>;
  const ba = elementBBox({ ...pre, rotation: 0 }), bb = elementBBox({ ...end, rotation: 0 });
  const w = lerp(ba.w, bb.w, t), h = lerp(ba.h, bb.h, t);
  out.x = lerp(ba.x, bb.x, t); out.y = lerp(ba.y, bb.y, t); out.width = w; out.height = h;
  out.rotation = lerpRot(pre.rotation ?? 0, end.rotation ?? 0, t);
  const oa = pre.opacity ?? 1, ob = end.opacity ?? 1;
  if (oa !== 1 || ob !== 1) out.opacity = lerp(oa, ob, t); else delete out.opacity;
  if (src.type === "line") {
    // a line's box IS its endpoints — keep them consistent with the lerped box
    const sx = src.x1 <= src.x2 ? 1 : -1, sy = src.y1 <= src.y2 ? 1 : -1;
    out.x1 = sx > 0 ? 0 : w; out.x2 = sx > 0 ? w : 0;
    out.y1 = sy > 0 ? 0 : h; out.y2 = sy > 0 ? h : 0;
  }
  return out as unknown as Element;
}

/** Named shape weights have an implicit zero at either missing endpoint.
 * Signed/extrapolated authored weights stay intact; the UI alone clamps sliders. */
export function lerpStates(a: Record<string, number> = {}, b: Record<string, number> = {}, t: number): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const value = lerp(Object.hasOwn(a, key) ? a[key] : 0, Object.hasOwn(b, key) ? b[key] : 0, t);
    if (value !== 0) out[key] = value;
  }
  return out;
}

/** Continuous field limits interpolate; map identity switches on raw progress.
 * An absent limit has no implicit data domain. Hosts resolve manifest defaults
 * before sampling when an authored field override changes. */
export function lerpFields(a: Record<string, ModelFieldOverride> = {}, b: Record<string, ModelFieldOverride> = {}, t: number, raw = t): Record<string, ModelFieldOverride> {
  const out: Record<string, ModelFieldOverride> = Object.create(null);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = Object.hasOwn(a, key) ? a[key] : undefined, right = Object.hasOwn(b, key) ? b[key] : undefined;
    const range = left?.range && right?.range ? [lerp(left.range[0], right.range[0], t), lerp(left.range[1], right.range[1], t)] as [number, number] : step(left?.range, right?.range, raw);
    const cmap = step(left?.cmap, right?.cmap, raw);
    if (range || cmap !== undefined) out[key] = { ...(range ? { range: [...range] } : {}), ...(cmap !== undefined ? { cmap } : {}) };
  }
  return out;
}

/** Sparse views have no implicit numeric domain: absent ends step in the
 * model, while the renderer resolves the manifest defaults and blends fits. */
export function lerpView(a: PlotView | undefined, b: PlotView | undefined, t: number, raw = t): PlotView | undefined {
  if (raw <= 0) return a ? structuredClone(a) : undefined;
  if (raw >= 1) return b ? structuredClone(b) : undefined;
  const out: PlotView = {};
  for (const key of ["x", "y"] as const) {
    const pa = a?.[key], pb = b?.[key];
    const domain = pa?.domain && pb?.domain ? pa.domain.map((v, i) =>
      pa.scale === "log" && pb.scale === "log" && v > 0 && pb.domain![i] > 0
        ? Math.exp(lerp(Math.log(v), Math.log(pb.domain![i]), t)) : lerp(v, pb.domain![i], t)) as [number, number]
      : step(pa?.domain, pb?.domain, raw);
    const scale = step(pa?.scale, pb?.scale, raw);
    if (domain || scale) out[key] = { ...(domain ? { domain: [...domain] } : {}), ...(scale ? { scale } : {}) };
  }
  return out.x || out.y ? out : undefined;
}

/** Live colour scales tween per scale id: limits and the norm's numbers interpolate (in log
 *  space when both ends are log norms), a colormap given as a table blends per entry in
 *  OKLab (both resampled to 256), a norm kind / reversed / extend / a named colormap step at
 *  raw 0.5 (colour-system plan A7.7). Absent ends mean "as generated" and step. */
export function lerpColorScales(a: Record<string, ColorScaleView> | undefined, b: Record<string, ColorScaleView> | undefined, t: number, raw = t): Record<string, ColorScaleView> | undefined {
  if (a === b) return a ? structuredClone(a) : undefined;
  if (raw <= 0) return a ? structuredClone(a) : undefined;
  if (raw >= 1) return b ? structuredClone(b) : undefined;
  const out: Record<string, ColorScaleView> = {};
  for (const id of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const va = a?.[id], vb = b?.[id];
    if (!va || !vb) { const s = step(va, vb, raw); if (s) out[id] = structuredClone(s); continue; }
    const view: ColorScaleView = {};
    const ka = va.norm?.kind, kb = vb.norm?.kind;
    const kind = step(ka, kb, raw);
    const logBoth = ka === "log" && kb === "log";
    const norm: NonNullable<ColorScaleView["norm"]> = {};
    if (kind) norm.kind = kind;
    for (const key of ["vmin", "vmax", "vcenter", "gamma", "linthresh", "linscale"] as const) {
      const na = va.norm?.[key], nb = vb.norm?.[key];
      if (typeof na === "number" && typeof nb === "number") norm[key] = logBoth && na > 0 && nb > 0 && (key === "vmin" || key === "vmax") ? Math.exp(lerp(Math.log(na), Math.log(nb), t)) : lerp(na, nb, t);
      else { const s = step(na, nb, raw); if (s !== undefined) norm[key] = s; }
    }
    if (Object.keys(norm).length) view.norm = norm;
    const ca = va.cmap, cb = vb.cmap;
    if (ca && cb && typeof ca === "object" && typeof cb === "object") {
      if (sameTable(ca, cb)) { view.cmap = structuredClone(ca); }
      else {
      const la = resampleLut(ca.lut, 256), lb = resampleLut(cb.lut, 256);
      view.cmap = { lut: la.map((c, i) => lerpColor(c, lb[i], t, undefined, raw)),
        ...(ca.under && cb.under ? { under: lerpColor(ca.under, cb.under, t, undefined, raw) } : {}),
        ...(ca.over && cb.over ? { over: lerpColor(ca.over, cb.over, t, undefined, raw) } : {}),
        ...(ca.bad && cb.bad ? { bad: lerpColor(ca.bad, cb.bad, t, undefined, raw) } : {}) };
      }
    } else { const s = step(ca, cb, raw); if (s) view.cmap = structuredClone(s); }
    const rev = step(va.reversed, vb.reversed, raw); if (rev) view.reversed = true;
    const ext = step(va.extend, vb.extend, raw); if (ext) view.extend = ext;
    if (Object.keys(view).length) out[id] = view;
  }
  return Object.keys(out).length ? out : undefined;
}

const sameTable = (a: ColorScaleTable, b: ColorScaleTable): boolean =>
  a.lut.length === b.lut.length && a.under === b.under && a.over === b.over && a.bad === b.bad && a.lut.every((c, i) => c === b.lut[i]);

/** The frame's colour scales for a plot whose Change edits them, completed from the manifest so
 *  an absent end ("as generated") GLIDES instead of stepping: every scale either end names gets a
 *  full view at both ends (its effective table, kind, limits and parameters, extend), and the
 *  per-field tween above interpolates between them. The player's transform host calls this with
 *  the frame's manifest; lerpState (no manifest) keeps the sparse step for other consumers. */
export function tweenColorScales(manifest: FluxPlotManifest | undefined, a: Record<string, ColorScaleView> | undefined, b: Record<string, ColorScaleView> | undefined, t: number, raw = t): Record<string, ColorScaleView> | undefined {
  if (a === b) return a;
  if (!manifest?.colorScales?.length) return lerpColorScales(a, b, t, raw);
  const ids = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const complete = (side: Record<string, ColorScaleView> | undefined): Record<string, ColorScaleView> => {
    const out: Record<string, ColorScaleView> = {};
    for (const id of ids) {
      const scale = manifest.colorScales!.find((s) => s.id === id);
      const own = side?.[id];
      if (!scale) { if (own) out[id] = own; continue; }
      const eff = effectiveScale(scale, own, colormapLut);
      if (eff.issues.length || eff.unresolved) { if (own) out[id] = own; continue; }
      const norm: NonNullable<ColorScaleView["norm"]> = { kind: eff.norm.kind as NonNullable<ColorScaleView["norm"]>["kind"] };
      for (const k of ["vmin", "vmax", "vcenter", "gamma", "linthresh", "linscale"] as const) if (eff.norm[k] != null) norm[k] = eff.norm[k] as number;
      out[id] = { cmap: { lut: [...eff.colormap.lut], under: eff.colormap.under, over: eff.colormap.over, bad: eff.colormap.bad, name: eff.colormap.name }, norm, extend: eff.norm.extend };
    }
    return out;
  };
  return lerpColorScales(complete(a), complete(b), t, raw);
}

function resampleLut(lut: string[], n: number): string[] {
  if (lut.length === n) return lut;
  return Array.from({ length: n }, (_, i) => lut[Math.min(lut.length - 1, Math.trunc((i / n) * lut.length))]);
}

function lerpOverrides(
  a: Record<string, PartOverride> | undefined,
  b: Record<string, PartOverride> | undefined,
  t: number,
  raw = t,
): Record<string, PartOverride> {
  const out: Record<string, PartOverride> = {};
  const parts = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const part of parts) {
    const pa = a?.[part], pb = b?.[part];
    if (!pa && !pb) continue;
    const merged: PartOverride = {};
    const keys = new Set([...Object.keys(pa ?? {}), ...Object.keys(pb ?? {})]);
    for (const k of keys) {
      const va = pa?.[k], vb = pb?.[k];
      if (eq(va, vb)) {
        if (va !== undefined) merged[k] = va as PartOverride[string];
        continue;
      }
      if ((k === "stroke" || k === "fill") && (typeof va === "string" || typeof vb === "string")) {
        // one side absent = "generator default" — not a color we can blend; step.
        if (typeof va === "string" && typeof vb === "string") merged[k] = lerpColor(va, vb, t, undefined, raw);
        else {
          const v = step(va, vb, raw);
          if (typeof v === "string") merged[k] = v;
        }
      } else if (typeof va === "number" && typeof vb === "number") {
        merged[k] = lerp(va, vb, t);
      } else if ((typeof va === "number" || typeof vb === "number") && (k === "dx" || k === "dy")) {
        merged[k] = lerp(Number(va ?? 0), Number(vb ?? 0), t);
      } else {
        const v = step(va, vb, raw);
        if (v !== undefined) merged[k] = v;
      }
    }
    if (Object.keys(merged).length) out[part] = merged;
  }
  return out;
}

// --- pre-state folding (chained transforms) -----------------------------------

/** The pre-state (t1) of a transform on beat `beatIndex`: the document (beat-0)
 *  element ⊕ the state of every ENABLED transform-family track on the same
 *  target in EARLIER beats, in beat order. Pure — computed from deck data
 *  alone, so preview/present/export agree from deck.json. `tracks` is the
 *  slide's beats' tracks in beat order (the caller filters by target). */
export function foldPreState(
  docEl: Element,
  earlierStates: (Record<string, unknown> | undefined | null)[],
): Element {
  let el = structuredClone(docEl);
  for (const s of earlierStates) {
    if (s) el = applyState(el, s);
  }
  return el;
}

/** The ENABLED transform-family states on `target` in beats strictly before
 *  `beatIndex`, in beat order — foldPreState's input, extracted so callers
 *  that hold the base element separately (the endpoint checkout) share the
 *  exact walk the player uses. */
export function earlierTransformStates(
  beats: Slide["beats"],
  target: string,
  beatIndex: number,
): (Record<string, unknown> | undefined)[] {
  const out: (Record<string, unknown> | undefined)[] = [];
  for (let i = 0; i < Math.min(beatIndex, beats.length); i++) {
    for (const t of beats[i].tracks) {
      if (t.disabled || t.target !== target || familyOf(t) !== "transform") continue;
      out.push(t.to?.state as Record<string, unknown> | undefined);
    }
  }
  return out;
}

/** The pre-state (t1) of a transform on beat `beatIndex` for `target`: the
 *  document (beat-0) element ⊕ every earlier enabled transform state, in beat
 *  order (rework §4.1). Pure over deck data — preview, present, export, and
 *  the endpoint checkout all agree from deck.json alone. */
export function transformPreState(slide: Slide, target: string, beatIndex: number): Element | null {
  const docEl = slide.elements.find((e) => e.id === target);
  if (!docEl) return null;
  const out = foldPreState(docEl, earlierTransformStates(slide.beats, target, beatIndex));
  // Content identity is a separate authored channel, but is still part of a
  // transform's effective source. A→B→C must start the second move at B.
  if (out.type === "plot" || out.type === "image" || out.type === "model3d") {
    for (let i = 0; i < Math.min(beatIndex, slide.beats.length); i++) {
      for (const track of slide.beats[i].tracks) {
        if (!track.disabled && track.target === target && familyOf(track) === "transform" && track.to?.assetId) out.assetId = track.to.assetId;
      }
    }
  }
  return out;
}

/** The end state of a transform track: pre ⊕ state, plus the content half
 *  (`to.assetId`) for element kinds that carry an asset. ONE definition — the
 *  compiler, the player and the endpoint checkout all call it. */
export function transformEndState(pre: Element, track: { to?: { state?: Record<string, unknown>; assetId?: string } }): Element {
  const end = applyState(pre, track.to?.state);
  if (track.to?.assetId && (end.type === "plot" || end.type === "image" || end.type === "model3d")) end.assetId = track.to.assetId;
  return end;
}

/** Build, ahead of time, the node correspondences this slide's BECOME
 *  transforms will need, so pressing play does not wait for them and neither
 *  does the first frame after it. The work is a pure function of the deck
 *  (`planOutlines` memoizes it), so doing it early is doing it once: the
 *  player's own `planElementMorph` then finds every answer already there.
 *
 *  The animator calls this when it OPENS, which is the only moment with real
 *  time in it — a person spends at least a few hundred milliseconds looking at
 *  the timeline before they press play, while play → first frame is measured
 *  in tens of milliseconds and budgeted (§6). Warming is never required for
 *  correctness: skip it, interrupt it, call it twice, and every caller still
 *  gets the same answer, only later. */
export function warmSlideMorphs(slide: Slide, geometry?: GeometryCtx): void {
  let compiled: ReturnType<typeof compileSlide> | undefined;
  for (let bi = 0; bi < slide.beats.length; bi++) {
    for (const track of slide.beats[bi].tracks) {
      if (track.disabled || track.keyframes || familyOf(track) !== "transform") continue;
      if (isHandoff(track)) {
        // Plot hosts pass their scoped pristine roots/manifests. Geometry does
        // not read camera coordinates, so its warm compile needs no stage size.
        if (geometry) {
          compiled ??= compileSlide(slide, { width: 1, height: 1 }, { plotManifest: geometry.manifest });
          planHandoff(track, compiled.sample(bi, track.start ?? 0), { ...geometry, groups: slide.groups }).prepare();
        }
        continue;
      }
      const pre = transformPreState(slide, track.target, bi);
      if (!pre) continue;
      const end = transformEndState(pre, track);
      if (!outlineMorphable(pre, end)) continue;
      planElementMorph(pre, end)?.prepare?.();
    }
  }
}
