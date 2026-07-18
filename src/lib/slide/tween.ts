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

import type { Element, PartOverride, VectorNode } from "../types";
import type { Slide } from "./types";
import { familyOf } from "./family";
import { lerpColor } from "../color/interp";
import { pathD, pathToNodes, resampleNodes } from "../path";

// --- the property law --------------------------------------------------------

/** Props never captured into a transform state (identity/bookkeeping/derived).
 *  `assetId` is here too: a plot's content target lives in `to.assetId` (the
 *  morph half), never in the state patch. */
const NEVER_CAPTURED = new Set([
  "id", "type", "name", "groupId", "locked", "hidden", "lockAspect",
  "assetId", "styleId", "panelLabel", "lines", "needsLayout",
  "source", "manifestRef",
]);

/** Scalar-lerp props (rotation is special-cased for shortest arc). */
const NUM_PROPS = new Set([
  "x", "y", "width", "height", "opacity", "strokeWidth", "fontSize",
  "cornerRadius", "lineHeight", "x1", "y1", "x2", "y2", "contentScale",
  "arrowSize",
]);

/** OKLab-lerp props. */
const COLOR_PROPS = new Set(["fill", "stroke", "color"]);

/** Text props whose change invalidates the wrap cache (`lines`). */
const METRIC_PROPS = new Set([
  "text", "fontSize", "fontFamily", "fontWeight", "fontStyle", "width",
  "sizing", "lineHeight", "underline",
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
  const out = structuredClone(el) as unknown as Record<string, unknown>;
  if (!state) return out as unknown as Element;
  let metrics = false;
  for (const [k, v] of Object.entries(state)) {
    if (NEVER_CAPTURED.has(k)) continue;
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
  if (metrics && (out.type === "text")) {
    delete out.lines;
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
  for (const k of keys) {
    if (NEVER_CAPTURED.has(k)) continue;
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
      if (k in a) out[k] = null;
    } else if (!eq(a[k], b[k])) {
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
  const NUM = /-?\d[\d,]*\.?\d*/;
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
export function lerpDash(a: number[] | undefined, b: number[] | undefined, t: number): number[] | undefined {
  const has = (d?: number[]) => !!d && d.length > 0;
  if (!has(a) && !has(b)) return undefined;
  if (t <= 0) return a ? [...a] : undefined;
  if (t >= 1) return b ? [...b] : undefined;
  const even = (d: number[]) => (d.length % 2 ? [...d, ...d] : [...d]);
  const solidTwin = (other: number[]) => even(other).map((v, i) => (i % 2 ? 0 : v));
  const da = has(a) ? even(a!) : solidTwin(b!);
  const db = has(b) ? even(b!) : solidTwin(a!);
  const n = Math.max(da.length, db.length);
  // pad by repetition to the common length (both even → repeats stay aligned)
  const pad = (d: number[]) => Array.from({ length: n }, (_, i) => d[i % d.length]);
  const pa = pad(da), pb = pad(db);
  return pa.map((v, i) => Math.max(0, lerp(v, pb[i], t)));
}

// --- the content plan (what the driver renders) -------------------------------

export type ContentMode = "tween" | "crossfade";

export interface ContentPlan {
  /** How the CONTENT layer animates ("tween": one re-rendered layer;
   *  "crossfade": two stacked layers, opacity cross-lerped — geometry still
   *  moves via the lerped box). */
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
  "cornerRadius", "crop", "contentScale",
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
  if (pre.type === "path" && end.type === "path" && Boolean(pre.closed) !== Boolean(end.closed)) {
    mode = "crossfade"; // topology change — not interpolable
  }
  return { mode, ...(textTween ? { textTween } : {}), contentDirty, geometryDirty };
}

// --- lerpElement --------------------------------------------------------------

/** Interpolate two states of ONE element (same id/type). t≤0 / t≥1 return
 *  clones of the endpoints verbatim (true end nodes, no resample residue).
 *  Non-interpolable props step at t = 0.5. */
export function lerpElement(pre: Element, end: Element, t: number): Element {
  if (t <= 0) return structuredClone(pre);
  if (t >= 1) return structuredClone(end);
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
    } else if (NUM_PROPS.has(k) && (typeof va === "number" || typeof vb === "number")) {
      const fa = typeof va === "number" ? va : k === "contentScale" ? 1 : 0;
      const fb = typeof vb === "number" ? vb : k === "contentScale" ? 1 : 0;
      out[k] = lerp(fa, fb, t);
    } else if (COLOR_PROPS.has(k) && typeof va === "string" && typeof vb === "string") {
      out[k] = lerpColor(va, vb, t);
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
        if (step(va, vb, t) === undefined) delete out[k];
        else out[k] = structuredClone(step(va, vb, t));
      }
    } else if (k === "overrides") {
      out[k] = lerpOverrides(va as Record<string, PartOverride> | undefined, vb as Record<string, PartOverride> | undefined, t);
      if (!Object.keys(out[k] as object).length) delete out[k];
    } else if (k === "nodes" || k === "d" || k === "closed") {
      continue; // path geometry handled wholesale below
    } else if (k === "text" && typeof va === "string" && typeof vb === "string") {
      const sampler = numericTextTween(va, vb);
      out[k] = sampler ? sampler(t) : step(va, vb, t);
    } else if (k === "fontWeight") {
      out[k] = Math.round(lerp(Number(va ?? 400), Number(vb ?? 400), t) / 100) * 100;
    } else {
      // discrete (booleans, align, fontFamily, sizing, arrow flags, cap, …)
      const v = step(va, vb, t);
      if (v === undefined) delete out[k];
      else out[k] = structuredClone(v);
    }
  }
  // path geometry, wholesale
  if (pre.type === "path" && end.type === "path") {
    const closedA = Boolean(pre.closed), closedB = Boolean(end.closed);
    if (closedA === closedB && (pre.d !== end.d || JSON.stringify(pre.nodes) !== JSON.stringify(end.nodes))) {
      const nodes = lerpNodes(nodesOf(pre), nodesOf(end), closedB, t);
      (out as unknown as { nodes: VectorNode[]; d: string; closed: boolean }).nodes = nodes;
      // cornerRadius was already lerped above (NUM_PROPS) — the frame's d
      // fillets with the interpolated radius over the interpolated skeleton.
      (out as unknown as { d: string }).d = pathD(nodes, closedB, (out as { cornerRadius?: number }).cornerRadius);
    } else if (closedA !== closedB) {
      // topology step (the driver crossfades; the model steps at 0.5)
      const src = t < 0.5 ? pre : end;
      (out as unknown as { closed: boolean; d: string }).closed = Boolean(src.closed);
      (out as unknown as { d: string }).d = src.d;
      if (src.nodes) (out as unknown as { nodes?: VectorNode[] }).nodes = structuredClone(src.nodes);
      else delete (out as unknown as { nodes?: VectorNode[] }).nodes;
    }
  }
  if (metrics && out.type === "text") {
    delete (out as unknown as { lines?: string[] }).lines;
    (out as unknown as { needsLayout?: true }).needsLayout = true;
  }
  return out as unknown as Element;
}

function lerpOverrides(
  a: Record<string, PartOverride> | undefined,
  b: Record<string, PartOverride> | undefined,
  t: number,
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
        if (typeof va === "string" && typeof vb === "string") merged[k] = lerpColor(va, vb, t);
        else {
          const v = step(va, vb, t);
          if (typeof v === "string") merged[k] = v;
        }
      } else if (typeof va === "number" && typeof vb === "number") {
        merged[k] = lerp(va, vb, t);
      } else if ((typeof va === "number" || typeof vb === "number") && (k === "dx" || k === "dy")) {
        merged[k] = lerp(Number(va ?? 0), Number(vb ?? 0), t);
      } else {
        const v = step(va, vb, t);
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
  return foldPreState(docEl, earlierTransformStates(slide.beats, target, beatIndex));
}
