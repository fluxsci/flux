// The property FIELD MODEL behind the F menu (2026-09-15 surface redesign) —
// extracted from FluxFigMenu.svelte so the Inspector's part section and the
// menu consume ONE field list: the same labels, the same hotkey letters, the
// same appliers. A Field is a hotkey + label + reader + LIVE applier (the
// caller wraps `apply` in an editSession so N keystrokes / wheel ticks are one
// undo). Numeric fields carry a range (`min`/`max`, or a `softMax` for
// unbounded-above values) so the menu can drive them from the mouse wheel and
// draw a track; select fields carry their options; colour fields are opened
// on the palette picker, which writes through colors.applyColor itself.
//
// Part fields apply to EVERY selected part (store.partSelections): five series
// of one plot, or the x-axis of four plots, edit as one. Reads come from the
// primary part; `mixed` flags a value that differs across the set.

import { get } from "svelte/store";
import type { Element, PartOverride, Project, SemanticPlotElement, TextStyle } from "../types";
import type { FluxPlotManifest } from "../plot/types";
import type { PartSelection } from "../store";
import { project, mutate, drawStyle, xrayOpen, xrayRoot } from "../store";
import { selectionTargets } from "./selectionTargets";
import { numericProperties, propertyValue, setNumericProperty, type NumericProperty } from "./elementProperties";
import { uniqueFieldKeys } from "./propertyFields";
import { partKind, partNode, readPartStyle } from "../plot/partStyle";
import * as ops from "../ops";
import { applyTextLayout, reflowTexts } from "../text";
import { applyTextStyleToPart, libraryOnly } from "../textStyles";
import { presetPicker, presetableSelection } from "../presets";
import { fluxFigMenuOpen } from "../settings";
import { getSnipMeta } from "../snipMeta";
import { pushToast } from "../toast";

export type FieldKind = "number" | "text" | "select" | "toggle" | "color" | "action";
export interface FieldOption {
  value: string;
  label: string;
}
export interface Field {
  key: string;
  label: string;
  group: string;
  kind: FieldKind;
  get: () => string | number | boolean;
  /** Live applier — the caller owns the edit session / undo entry. */
  apply: (v: string | number | boolean) => void;
  options?: FieldOption[];
  target?: "fill" | "stroke";
  step?: number;
  min?: number;
  max?: number;
  /** Ends of the wheel/track range when `min`/`max` are open-ended. */
  softMax?: number;
  softMin?: number;
  mixed?: boolean;
  count?: number;
}

export interface MenuGroup {
  name: string;
  fields: Field[];
}

export function groupFields(fs: Field[]): MenuGroup[] {
  const out: MenuGroup[] = [];
  for (const f of fs) {
    let g = out.find((o) => o.name === f.group);
    if (!g) {
      g = { name: f.group, fields: [] };
      out.push(g);
    }
    g.fields.push(f);
  }
  return out;
}

/** The wheel/track range of a numeric field, if it has one. */
export function fieldRange(f: Field): { min: number; max: number } | null {
  if (f.kind !== "number") return null;
  const min = f.min ?? f.softMin;
  const max = f.max ?? f.softMax;
  if (min == null || max == null || !(max > min)) return null;
  return { min, max };
}

// --- Plot-part fields ---------------------------------------------------------
// When parts are drilled, the menu edits THEM like the equivalent native
// object: a tick label gets the text fields, a gridline the stroke fields.
// Reads = effective values of the PRIMARY part (override → live DOM →
// pristine cache); writes = id-keyed overrides on every selected part
// (survive regeneration).
const PART_FONTS = ["Lato", "Latin Modern Roman", "Arial", "Helvetica", "Georgia", "Times New Roman", "DejaVu Sans"];

// Options for a named-style select: — None — + Project styles + the global
// Library (minus definitions the project already carries — project wins).
function styleOptions(p: Project, lib: TextStyle[]): FieldOption[] {
  const out: FieldOption[] = [{ value: "", label: "— None —" }];
  for (const st of p.textStyles ?? []) out.push({ value: st.id, label: st.name });
  for (const st of libraryOnly(p.textStyles, lib)) out.push({ value: "lib:" + st.id, label: `${st.name} (library)` });
  return out;
}
function resolveStyle(p: Project, lib: TextStyle[], v: string): { st: TextStyle; fromLibrary: boolean } | null {
  if (v.startsWith("lib:")) {
    const st = lib.find((s) => s.id === v.slice(4));
    return st ? { st, fromLibrary: true } : null;
  }
  const st = p.textStyles?.find((s) => s.id === v);
  return st ? { st, fromLibrary: false } : null;
}

/** Resolve the editable plot element behind each selected part. */
function resolveParts(p: Project, parts: PartSelection[]): { el: SemanticPlotElement; partId: string }[] {
  const out: { el: SemanticPlotElement; partId: string }[] = [];
  for (const ps of parts) {
    for (const f of p.figures)
      for (const e of selectionTargets(f, new Set([ps.elementId]), { editable: true }))
        if (e.id === ps.elementId && e.type === "plot") out.push({ el: e, partId: ps.partId });
  }
  return out;
}

// Hotkeys are LEFT-HAND keys only (owner request 2026-09-15): 1–6, q w e r t,
// a d g, z x c v b and ` — f and s belong to the menu itself; h and n (an
// index-finger stretch) are reserved for the rarest rows. The right hand never
// leaves the wheel.
export function buildPartFields(
  p: Project,
  parts: PartSelection[],
  manifests: Record<string, FluxPlotManifest>,
  lib: TextStyle[],
): Field[] {
  const resolved = resolveParts(p, parts);
  const primary = resolved[0];
  if (!primary) return [];
  const { el, partId } = primary;
  const manifest = manifests[el.assetId];
  const kind = partKind(manifest, partId, partNode(el, partId));
  const read = () => readPartStyle(el, partId, manifest);
  const readAll = () => resolved.map((r) => readPartStyle(r.el, r.partId, manifests[r.el.assetId]));
  const patch = (q: PartOverride) =>
    mutate((proj) => {
      for (const r of resolved) ops.setPartOverride(proj, r.el.id, r.partId, q);
    });
  const mixedOn = (prop: string) => {
    const vs = readAll().map((s) => s[prop]);
    return vs.some((v) => v !== vs[0]);
  };
  const F: Field[] = [];
  const G = "Plot part";
  const n = resolved.length;
  const pnum = (key: string, label: string, prop: string, step = 1, clamp?: (n: number) => number, range?: { min?: number; max?: number; softMax?: number }) =>
    F.push({
      key,
      label,
      group: G,
      kind: "number",
      step,
      ...range,
      mixed: n > 1 && mixedOn(prop),
      count: n,
      get: () => {
        const v = read()[prop];
        return typeof v === "number" ? v : 0;
      },
      apply: (v) => {
        let x = Number(v);
        if (!Number.isFinite(x)) return;
        if (clamp) x = clamp(x);
        patch({ [prop]: x });
      },
    });
  const color = (key: string, label: string, target: "fill" | "stroke") =>
    // The palette picker retargets to the parts itself (colors.applyColor
    // routes through applyPartStyle while parts are selected) — apply is a no-op.
    F.push({ key, label, group: G, kind: "color", target, count: n, get: () => String(read()[target] ?? "#000000"), apply: () => {} });
  const visible = () =>
    F.push({
      key: "v",
      label: "visible",
      group: G,
      kind: "toggle",
      count: n,
      get: () => !read().hidden,
      apply: () => {
        // All-shown → hide all; any hidden → show all (the Layers rule).
        const anyHidden = resolved.some((r) => Boolean(r.el.overrides?.[r.partId]?.hidden));
        patch({ hidden: !anyHidden });
      },
    });

  if (kind === "container") visible();
  if (kind === "text") {
    // Part font size is in PLOT UNITS (the SVG's own user units), not pt.
    pnum("e", "size", "fontSize", 0.5, (x) => Math.max(0.5, x), { min: 0.5, softMax: 40 });
    F.push({
      key: "b",
      label: "weight",
      group: G,
      kind: "select",
      count: n,
      options: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }],
      get: () => String(read().fontWeight ?? 400),
      apply: (v) => patch({ fontWeight: Number(v) }),
    });
    F.push({
      key: "q",
      label: "italic",
      group: G,
      kind: "toggle",
      count: n,
      get: () => read().fontStyle === "italic",
      apply: () => patch({ fontStyle: read().fontStyle === "italic" ? "normal" : "italic" }),
    });
    F.push({
      key: "2",
      label: "underline",
      group: G,
      kind: "toggle",
      count: n,
      get: () => read().textDecoration === "underline",
      apply: () => patch({ textDecoration: read().textDecoration === "underline" ? "none" : "underline" }),
    });
    F.push({
      key: "w",
      label: "font",
      group: G,
      kind: "select",
      count: n,
      options: (() => {
        const cur = String(read().fontFamily ?? "");
        const list = cur && !PART_FONTS.includes(cur) ? [cur, ...PART_FONTS] : PART_FONTS;
        return list.map((x) => ({ value: x, label: x }));
      })(),
      get: () => String(read().fontFamily ?? ""),
      apply: (v) => patch({ fontFamily: String(v) }),
    });
    color("c", "text colour", "fill");
    // Named text style → part override (fontSize converted canvas px → plot
    // units in applyTextStyleToPart; no styleId persisted on parts).
    F.push({
      key: "t",
      label: "text style",
      group: G,
      kind: "select",
      count: n,
      options: styleOptions(p, lib).filter((o) => o.value !== ""),
      get: () => "",
      apply: (v) => {
        const r = resolveStyle(get(project), lib, String(v));
        if (r) for (const part of resolved) applyTextStyleToPart(part.el.id, part.partId, r.st);
      },
    });
  } else if (kind === "line") {
    color("g", "stroke colour", "stroke");
    pnum("d", "stroke width", "strokeWidth", 0.25, (x) => Math.max(0, x), { min: 0, softMax: 12 });
  } else if (kind === "shape") {
    color("c", "fill colour", "fill");
    color("g", "stroke colour", "stroke");
    pnum("d", "stroke width", "strokeWidth", 0.25, (x) => Math.max(0, x), { min: 0, softMax: 12 });
  }
  pnum("a", "opacity", "opacity", 0.05, (x) => Math.min(1, Math.max(0, x)), { min: 0, max: 1 });
  pnum("x", "dx (plot units)", "dx", 1);
  pnum("z", "dy (plot units)", "dy", 1);
  if (kind !== "container") visible();
  return F;
}

// --- Element fields -----------------------------------------------------------
export function buildElementFields(p: Project, sel: Set<string>, lib: TextStyle[]): Field[] {
  const els: Element[] = [];
  for (const f of p.figures) for (const e of selectionTargets(f, sel, { editable: true })) els.push(e);
  sel = new Set(els.map((e) => e.id));
  const primary = els[0];
  if (!primary) return [];

  const upd = (fn: (e: Element, proj: Project) => void) =>
    mutate((proj) => {
      for (const f of proj.figures)
        for (const e of f.elements)
          if (sel.has(e.id)) {
            fn(e, proj);
            applyTextLayout(e);
          }
    });

  const F: Field[] = [];
  const num = (
    key: string,
    label: string,
    group: string,
    g: () => number,
    a: (e: Element, v: number, proj: Project) => void,
    step = 1,
    range?: { min?: number; max?: number; softMax?: number },
  ) =>
    F.push({ key, label, group, kind: "number", step, ...range, get: g, apply: (v) => upd((e, proj) => a(e, Number(v), proj)) });

  // The dimension base (pre-edit W/H per element) is supplied by the caller
  // per activation — see `dimBase` on the menu; the applier reads it lazily.
  const property = (name: NumericProperty) => {
    const d = numericProperties[name];
    const value = propertyValue(els, name);
    if (!value.count) return;
    F.push({
      key: d.key,
      label: d.label,
      group: d.group,
      kind: "number",
      step: d.step,
      min: d.min,
      max: d.max,
      softMax: d.softMax,
      softMin: d.softMin,
      mixed: value.mixed,
      count: value.count,
      get: () => propertyValue(els, name).value,
      apply: (v) => upd((e, proj) => setNumericProperty(proj, e, name, Number(v), dimBaseFor?.(e.id))),
    });
  };

  // Union-by-presence (multi-type selections): a section renders when ANY
  // selected element is of that family. `get` reads from the FIRST matching
  // element; every applier stays type-guarded per element (mirrors
  // ops.setElementStyle), so a mixed apply only touches valid targets.
  const textEl = els.find((e) => e.type === "text");
  const shapeEl = els.find((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path");
  const strokeEl = els.find((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path" || e.type === "line");
  const boxEl = els.find((e) => "width" in e && ops.supportsBoxDim(e.type));

  // Geometry (all element types; position reads the primary)
  property("x");
  property("y");
  if (boxEl) {
    // Aspect-lock-aware (ops.setBoxDim honors element.lockAspect): the
    // dimension base is captured at field activation, not from a half-typed
    // intermediate value.
    property("width");
    property("height");
    F.push({
      key: "1",
      label: "lock aspect ratio",
      group: "Geometry",
      kind: "toggle",
      get: () => !!(boxEl as { lockAspect?: boolean }).lockAspect,
      apply: () => {
        const ids = [...sel];
        const to = !(boxEl as { lockAspect?: boolean }).lockAspect;
        mutate((proj) => ops.setElementStyle(proj, ids, { lockAspect: to }));
      },
    });
  }
  property("rotation");
  property("opacity");

  // Reset crop: an action for cropped image/plot elements — one commit
  // through ops.setCrop(null): the box returns to the full content at its
  // current scale (content pinned), and this field disappears with the crop.
  const croppedEl = els.find((e) => (e.type === "image" || e.type === "plot") && e.crop);
  if (croppedEl) {
    const cid = croppedEl.id;
    F.push({
      key: "v",
      label: "reset crop (show full content)",
      group: "Geometry",
      kind: "action",
      get: () => true,
      apply: () => mutate((proj) => ops.setCrop(proj, cid, null)),
    });
  }

  // Paper snips: an image whose PNG carries flux-snip provenance offers its
  // source citation. Shared menu ⇒ slide mode gets it too.
  const snipEl = els.find((e) => e.type === "image" && getSnipMeta(e.assetId));
  if (snipEl && snipEl.type === "image") {
    const meta = getSnipMeta(snipEl.assetId)!;
    F.push({
      key: "n",
      label: `copy citation — ${meta.citation}`,
      group: "Source",
      kind: "action",
      get: () => true,
      apply: () => {
        void navigator.clipboard
          .writeText(meta.citation)
          .then(() => pushToast("info", "Citation copied", { detail: meta.citation }))
          .catch(() => pushToast("error", "Copy failed"));
      },
    });
  }

  // Fill
  if (shapeEl) {
    F.push({ key: "c", label: "fill color", group: "Fill", kind: "color", target: "fill", get: () => (shapeEl as { fill: string }).fill, apply: () => {} });
    // "none" as a first-class state: toggling back restores the draw-style fill.
    F.push({
      key: "2",
      label: "no fill (outline only)",
      group: "Fill",
      kind: "toggle",
      get: () => (shapeEl as { fill: string }).fill === "none" && !(shapeEl as { fillMap?: unknown }).fillMap,
      apply: () => {
        const to = (shapeEl as { fill: string }).fill === "none" && !(shapeEl as { fillMap?: unknown }).fillMap ? get(drawStyle).fill : "none";
        const ids = els.filter((e) => e.type === "rect" || e.type === "ellipse" || e.type === "path").map((e) => e.id);
        mutate((proj) => ops.setElementStyle(proj, ids, { fill: to }));
      },
    });
  }
  // Corner radius — rects AND paths (paths get Figma-style geometric fillets).
  const radiusEl = els.find((e) => e.type === "rect" || e.type === "path");
  if (radiusEl) property("cornerRadius");

  // Stroke
  if (strokeEl) {
    const se = strokeEl as Element & { dash?: number[] };
    F.push({ key: "g", label: "stroke color", group: "Stroke", kind: "color", target: "stroke", get: () => (strokeEl as { stroke: string }).stroke, apply: () => {} });
    property("strokeWidth");
    F.push({
      key: "3",
      label: "no stroke",
      group: "Stroke",
      kind: "toggle",
      get: () => (strokeEl as { stroke: string }).stroke === "none" && !(strokeEl as { strokeMap?: unknown }).strokeMap,
      apply: () => {
        const to = (strokeEl as { stroke: string }).stroke === "none" && !(strokeEl as { strokeMap?: unknown }).strokeMap ? get(drawStyle).stroke : "none";
        mutate((proj) => ops.setElementStyle(proj, [...sel], { stroke: to }));
      },
    });
    // Dash pattern ([len, gap] canvas px) — the toggle swaps solid↔[6,4]; the
    // two numbers appear while dashed. All writes go through ops.setElementStyle.
    F.push({
      key: "4",
      label: "dashed stroke",
      group: "Stroke",
      kind: "toggle",
      get: () => !!se.dash?.length,
      apply: () => {
        const ids = [...sel];
        const on = !!se.dash?.length;
        mutate((proj) => ops.setElementStyle(proj, ids, { dash: on ? [] : [6, 4] }));
      },
    });
    if (se.dash?.length) {
      F.push({ key: "5", label: "dash length", group: "Stroke", kind: "number", step: 0.5, min: 0.5, softMax: 40, get: () => se.dash?.[0] ?? 6, apply: (v) => { const ids = [...sel]; const gap = se.dash?.[1] ?? 4; mutate((proj) => ops.setElementStyle(proj, ids, { dash: [Math.max(0.5, Number(v)), gap] })); } });
      F.push({ key: "6", label: "dash gap", group: "Stroke", kind: "number", step: 0.5, min: 0.5, softMax: 40, get: () => se.dash?.[1] ?? 4, apply: (v) => { const ids = [...sel]; const len = se.dash?.[0] ?? 6; mutate((proj) => ops.setElementStyle(proj, ids, { dash: [len, Math.max(0.5, Number(v))] })); } });
    }
  }
  // Arrowheads — lines AND open paths share the flags.
  const arrowEl = els.find((e) => e.type === "line" || (e.type === "path" && !e.closed)) as
    | (Element & { arrowStart?: boolean; arrowEnd?: boolean; arrowStyle?: string; arrowSize?: number })
    | undefined;
  if (arrowEl) {
    const applyArrow = (patch: Partial<{ arrowStart: boolean; arrowEnd: boolean; arrowStyle: "filled" | "vee"; arrowSize: number }>) => {
      const ids = [...sel];
      mutate((proj) => ops.setElementStyle(proj, ids, patch));
    };
    F.push({ key: "q", label: "arrow start", group: "Stroke", kind: "toggle", get: () => !!arrowEl.arrowStart, apply: () => applyArrow({ arrowStart: !arrowEl.arrowStart }) });
    F.push({ key: "t", label: "arrow end", group: "Stroke", kind: "toggle", get: () => !!arrowEl.arrowEnd, apply: () => applyArrow({ arrowEnd: !arrowEl.arrowEnd }) });
    if (arrowEl.arrowStart || arrowEl.arrowEnd) {
      F.push({ key: "b", label: "arrowhead", group: "Stroke", kind: "select", options: [{ value: "filled", label: "Filled" }, { value: "vee", label: "V-line" }], get: () => arrowEl.arrowStyle ?? "filled", apply: (v) => applyArrow({ arrowStyle: v as "filled" | "vee" }) });
      num("e", "arrowhead size (× width)", "Stroke", () => arrowEl.arrowSize ?? 4, (e, v) => { if (e.type === "line" || e.type === "path") (e as { arrowSize?: number }).arrowSize = Math.max(1, v); }, 0.5, { min: 1, softMax: 12 });
    }
  }
  // Cap — lines AND open paths.
  const capEl = els.find((e) => e.type === "line" || (e.type === "path" && !e.closed));
  if (capEl) {
    F.push({ key: "h", label: "cap style", group: "Stroke", kind: "select", options: [{ value: "round", label: "Round" }, { value: "butt", label: "Flat" }, { value: "square", label: "Square" }], get: () => (capEl as { cap?: string }).cap ?? "round", apply: (v) => { const ids = [...sel]; mutate((proj) => ops.setElementStyle(proj, ids, { cap: v as "butt" | "round" | "square" })); } });
  }

  // Presets — save a SINGLE primitive, or a GROUP of primitives + text, to the
  // machine-global design library. Insert side lives on Ctrl+P.
  if (presetableSelection(els)) {
    const pids = els.map((e) => e.id);
    F.push({
      key: "`",
      label: els.length > 1 ? `save group as preset… (${els.length} items)` : "save as preset…",
      group: "Presets",
      kind: "action",
      get: () => false,
      apply: () => {
        fluxFigMenuOpen.set(false);
        presetPicker.set({ mode: "save", elementIds: pids });
      },
    });
  }

  // Text
  if (textEl) {
    // 'c' stays text colour for text-only selections (muscle memory); it
    // yields to the Fill section's fill colour in mixed selections.
    const tcKey = shapeEl ? "n" : "c";
    const tEl = textEl as Element & { type: "text" };
    F.push({ key: "t", label: "text", group: "Text", kind: "text", get: () => tEl.text, apply: (v) => upd((e) => { if (e.type === "text") e.text = String(v); }) });
    // Font size in POINTS (stored px × 0.75) — same unit as journal specs.
    property("fontSize");
    F.push({ key: "b", label: "weight", group: "Text", kind: "select", options: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }], get: () => String(tEl.fontWeight), apply: (v) => upd((e, proj) => { if (e.type === "text") { e.fontWeight = Number(v); ops.detachOnManualEdit(proj, e, ["fontWeight"]); } }) });
    F.push({ key: "v", label: "italic", group: "Text", kind: "toggle", get: () => tEl.fontStyle === "italic", apply: () => { const list = [...sel]; mutate((proj) => { ops.toggleTextStyle(proj, list, "italic"); reflowTexts(proj, list); }); } });
    F.push({ key: "2", label: "underline", group: "Text", kind: "toggle", get: () => !!tEl.underline, apply: () => { const list = [...sel]; mutate((proj) => { ops.toggleTextStyle(proj, list, "underline"); reflowTexts(proj, list); }); } });
    F.push({ key: "q", label: "font", group: "Text", kind: "select", options: ["Georgia", "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana"].map((x) => ({ value: x, label: x })), get: () => tEl.fontFamily, apply: (v) => upd((e, proj) => { if (e.type === "text") { e.fontFamily = String(v); ops.detachOnManualEdit(proj, e, ["fontFamily"]); } }) });
    F.push({ key: "3", label: "align", group: "Text", kind: "select", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }], get: () => tEl.align, apply: (v) => upd((e, proj) => { if (e.type === "text") { e.align = v as "left" | "center" | "right"; ops.detachOnManualEdit(proj, e, ["align"]); } }) });
    property("lineHeight");
    F.push({
      key: "4",
      label: "sizing",
      group: "Text",
      kind: "select",
      options: [{ value: "auto", label: "Auto (hug)" }, { value: "auto-h", label: "Auto H (wrap)" }, { value: "fixed", label: "Fixed" }],
      get: () => tEl.sizing ?? "auto",
      apply: (v) => upd((e) => { if (e.type === "text") e.sizing = v as "auto" | "auto-h" | "fixed"; }),
    });
    // Named text style ('p').
    F.push({
      key: "5",
      label: "text style",
      group: "Text",
      kind: "select",
      options: styleOptions(p, lib),
      get: () => tEl.styleId ?? "",
      apply: (v) => {
        const val = String(v);
        const list = [...sel];
        if (val === "") {
          upd((e) => { if (e.type === "text") delete e.styleId; });
          return;
        }
        const r = resolveStyle(get(project), lib, val);
        if (!r) return;
        mutate((proj) => {
          if (r.fromLibrary && !proj.textStyles?.some((s) => s.id === r.st.id)) {
            ops.createTextStyle(proj, structuredClone(r.st)); // copy-on-apply
          }
          ops.applyTextStyle(proj, list, r.st.id);
          reflowTexts(proj, list);
        });
      },
    });
    F.push({ key: tcKey, label: "text color", group: "Text", kind: "color", target: "fill", get: () => tEl.color, apply: () => {} });
  }

  return F;
}

// The dimension base — pre-edit W/H per element, captured by the menu when a
// w/h field activates (these appliers run live per keystroke / wheel tick and
// the lock ratio must come from before the edit, not from a half-typed value).
// Module-level because the field closures are built before activation.
let dimBaseFor: ((id: string) => { w: number; h: number } | undefined) | null = null;
export function setDimensionBase(base: Map<string, { w: number; h: number }> | null) {
  dimBaseFor = base ? (id) => base.get(id) : null;
}

/** The complete menu field list for the current selection: part fields when
 *  parts are drilled, else element fields; hotkeys made unique (f/s reserved). */
export function buildMenuFields(
  p: Project,
  sel: Set<string>,
  parts: PartSelection[],
  manifests: Record<string, FluxPlotManifest>,
  lib: TextStyle[],
): Field[] {
  const fields = parts.length ? buildPartFields(p, parts, manifests, lib) : buildElementFields(p, sel, lib);
  // A fluxplot with colour-scaled fields (heatmap / contour): its colormap is
  // picked in the X-ray's Color scales (every collection fluxplot ships), so the
  // menu offers the door — one selected plot, `c`, the X-ray opens rooted on it.
  if (!parts.length && sel.size === 1) {
    for (const f of p.figures) {
      const el = f.elements.find((e) => sel.has(e.id));
      if (!el) continue;
      if (el.type === "plot" && manifests[el.assetId]?.series?.some((s) => s.field?.controlKey)) {
        fields.push({
          key: "c",
          label: "colour scale… (X-ray)",
          group: "Plot",
          kind: "action",
          get: () => true,
          apply: () => {
            fluxFigMenuOpen.set(false);
            xrayRoot.set({ kind: "element", figId: f.id, elementId: el.id });
            xrayOpen.set(true);
          },
        });
      }
      break;
    }
  }
  return uniqueFieldKeys(fields);
}
