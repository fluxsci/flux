import { writable, get } from "svelte/store";
import type { ColorGroup, ColorSwatch, GradientFill, Id, PartOverride } from "./types";
import { project, selection, partSelection, partSelections, drawStyle, commit, mutate } from "./store";
import { selectionTargets } from "./interact/selectionTargets";
import { makeGradientFill } from "./color/collections";
import * as ops from "./ops";
import { activeTextRange } from "./textEditRange";
import { rangeColor } from "./textRuns";

/** Letters selected inside one editable text box: colour controls paint those
 *  letters, not the box (textEditRange.ts). */
function editableTextRange() {
  const hit = activeTextRange();
  if (!hit) return null;
  const id = hit.range.id;
  return get(project).figures.some((f) => selectionTargets(f, new Set([id]), { editable: true }).some((e) => e.id === id)) ? hit : null;
}

// Whether palette clicks set fill or stroke.
export const colorTarget = writable<"fill" | "stroke">("fill");

// (FIG-15: the F/S "quick colour picker" store was dead — never wired to a key or a UI — and
// F is actually the FluxFig property menu. Removed the store; Help.svelte corrected to match.)

// Write a style override onto a specific plot PART or GROUP, keyed by its stable
// semantic id (e.g. "control.line", or a group id like "axis.x.tick-labels").
// Survives plot regeneration because the id is deterministic (spec §7). Undoable.
export function applyPartStyleTo(elementId: Id, partId: string, patch: PartOverride, preview = false) {
  if (!get(project).figures.some(f => selectionTargets(f, new Set([elementId]), { editable: true }).length)) return;
  (preview ? mutate : commit)((p) => ops.setPartOverride(p, elementId, partId, patch));
}

// Write a style override onto EVERY selected plot part (the canvas drill-in
// selection, or the X-ray's multi-pick — store.partSelections). Used by the
// inspector + by the palette picker via applyColor. One transaction.
export function applyPartStyle(patch: PartOverride, preview = false) {
  const parts = get(partSelections);
  if (!parts.length) return;
  const editable = parts.filter((ps) =>
    get(project).figures.some((f) => selectionTargets(f, new Set([ps.elementId]), { editable: true }).length),
  );
  if (!editable.length) return;
  (preview ? mutate : commit)((p) => {
    for (const ps of editable) ops.setPartOverride(p, ps.elementId, ps.partId, patch);
  });
}

// Apply a colour to the current selection (or to the draw style if nothing is
// selected, so the next shape uses it). When a plot PART is selected, the colour
// retargets to that part's override instead of the whole element.
//
// `hex` may be the literal "none" (the palette's None swatch): valid for shape
// fill/stroke, but guarded where it would only ever be a foot-gun — text colour
// (invisible text) and a line's paint via the FILL target (lines have no fill;
// only an explicit stroke-none may blank one).
export function applyColor(hex: string, target = get(colorTarget), preview = false) {
  const none = hex === "none";
  if (get(partSelection)) {
    applyPartStyle(target === "fill" ? { fill: hex } : { stroke: hex }, preview);
    return;
  }
  const sel = get(selection);
  const ranged = editableTextRange();
  if (ranged) {
    if (none) return; // text colour never blanks, per range as for the box
    const { id, from, to } = ranged.range;
    (preview ? mutate : commit)((p) => ops.setTextRunColor(p, id, from, to, hex));
    return;
  }
  if (sel.size === 0) {
    drawStyle.update((s) =>
      target === "fill"
        ? { ...s, fill: hex }
        : { ...s, stroke: hex, ...(none ? {} : { textColor: hex }) },
    );
    return;
  }
  (preview ? mutate : commit)((p) => {
    for (const f of p.figures)
      for (const e of selectionTargets(f, sel, { editable: true })) {
        // a solid pick replaces a gradient (the map is the paint while set)
        if (e.type === "text") {
          if (none) continue;
          e.color = hex;
          delete e.fillMap;
          // a manual colour edit detaches a linked named style IF that style
          // defines a colour (ops.detachOnManualEdit no-ops otherwise)
          ops.detachOnManualEdit(p, e, ["color"]);
        } else if (e.type === "line") {
          if (none && target === "fill") continue;
          e.stroke = hex;
          delete e.strokeMap;
        } else if (e.type === "rect" || e.type === "ellipse" || e.type === "path") {
          if (target === "fill") {
            e.fill = hex;
            delete e.fillMap;
          } else {
            e.stroke = hex;
            delete e.strokeMap;
          }
        }
      }
  });
}

// Apply a colormap as a GRADIENT along an axis (2026-09-16, owner note): the
// whole map laid across each selected element's box — fill or stroke of a
// shape, the stroke of a line/arrow, the glyphs of a text. Plot parts and the
// draw style take solid colours only (returns false, nothing written). The
// element's solid colour stays underneath as the fallback for an unknown map.
export function applyColormap(map: string, axis: GradientFill["axis"], target = get(colorTarget), preview = false): boolean {
  if (get(partSelection)) return false;
  // A gradient spans a whole box; with letters selected it declines rather than
  // repaint every letter the user did not select.
  if (editableTextRange()) return false;
  const sel = get(selection);
  if (sel.size === 0) return false;
  // the stops are resolved here, once, and stored on each element (self-contained)
  const g = makeGradientFill(map, axis);
  if (!g) return false;
  const copy = (): GradientFill => ({ ...g, stops: [...g.stops] });
  (preview ? mutate : commit)((p) => {
    for (const f of p.figures)
      for (const e of selectionTargets(f, sel, { editable: true })) {
        if (e.type === "text") {
          e.fillMap = copy();
          ops.detachOnManualEdit(p, e, ["color"]);
        } else if (e.type === "line") {
          e.strokeMap = copy();
        } else if (e.type === "rect" || e.type === "ellipse" || e.type === "path") {
          if (target === "fill") e.fillMap = copy();
          else e.strokeMap = copy();
        }
      }
  });
  return true;
}

/** The gradient the selection's first element carries for `target` (null = solid). */
export function currentGradient(target: "fill" | "stroke"): GradientFill | null {
  const sel = get(selection);
  if (sel.size === 0 || get(partSelection)) return null;
  for (const f of get(project).figures)
    for (const e of selectionTargets(f, sel, { editable: true })) {
      if (e.type === "text") return e.fillMap ?? null;
      if (e.type === "line") return e.strokeMap ?? null;
      if (e.type === "rect" || e.type === "ellipse" || e.type === "path") return (target === "fill" ? e.fillMap : e.strokeMap) ?? null;
    }
  return null;
}

export function addRecentColor(hex: string, preview = false) {
  if (get(project).palette[0] === hex) return;
  (preview ? mutate : commit)((p) => {
    p.palette = [hex, ...p.palette.filter((c) => c !== hex)].slice(0, 12);
  });
}

// Set per-element opacity (0..1) across the selection.
export function setOpacity(v: number, preview = false) {
  const sel = get(selection);
  if (sel.size === 0) return;
  (preview ? mutate : commit)((p) => {
    for (const f of p.figures)
      for (const e of selectionTargets(f, sel, { editable: true })) e.opacity = Math.max(0, Math.min(1, v));
  });
}

// Set stroke width across the selection (elements that support it).
export function setStrokeWidth(v: number, preview = false) {
  const sel = get(selection);
  if (sel.size === 0) return;
  (preview ? mutate : commit)((p) => {
    for (const f of p.figures)
      for (const e of selectionTargets(f, sel, { editable: true }))
        if ("strokeWidth" in e) e.strokeWidth = Math.max(0, v);
  });
}

// Best-guess current colour of the selection for a given target, for seeding
// the full editor. Returns the first selected element's relevant colour.
export function currentColor(target: "fill" | "stroke"): string {
  const sel = get(selection);
  const p = get(project);
  const ps = get(partSelection);
  if (ps) {
    for (const f of p.figures)
      for (const e of f.elements)
        if (e.id === ps.elementId && e.type === "plot") {
          const v = e.overrides?.[ps.partId]?.[target];
          if (typeof v === "string") return v;
        }
  }
  const ranged = activeTextRange(p, sel);
  if (ranged) return rangeColor(ranged.element, ranged.range.from, ranged.range.to) ?? ranged.element.color;
  for (const f of p.figures)
    for (const e of f.elements) {
      if (!sel.has(e.id)) continue;
      if (e.type === "text") return e.color;
      if (e.type === "line") return e.stroke;
      if (e.type === "rect" || e.type === "ellipse" || e.type === "path")
        return target === "fill" ? e.fill : e.stroke;
    }
  return "#000000";
}

// ---------------------------------------------------------------------------
// Parse a Figma / DTCG design-tokens JSON export into hue groups of swatches.
// Handles the shape Figma exports: top-level groups -> token name -> {$type,
// $value:{hex, alpha}}. Recurses through nested groups; ignores non-colour
// tokens and $-prefixed metadata keys.
// ---------------------------------------------------------------------------
export function parseTokens(json: unknown): ColorGroup[] {
  const groups: ColorGroup[] = [];
  if (!json || typeof json !== "object") return groups;

  for (const [key, val] of Object.entries(json as Record<string, unknown>)) {
    if (key.startsWith("$")) continue;
    const swatches: ColorSwatch[] = [];
    collectColors(val, "", swatches);
    if (swatches.length) groups.push({ name: key, swatches });
  }
  return groups;
}

function collectColors(node: unknown, path: string, out: ColorSwatch[]) {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (obj.$type === "color" && obj.$value) {
    const hex = swatchHex(obj.$value);
    if (hex) out.push({ name: path || "color", hex });
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    collectColors(v, k, out);
  }
}

function swatchHex(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    let hex = typeof v.hex === "string" ? v.hex : null;
    if (!hex && Array.isArray(v.components)) {
      const [r, g, b] = v.components as number[];
      hex = "#" + [r, g, b].map((c) => to2(Math.round(c * 255))).join("");
    }
    if (!hex) return null;
    hex = hex.toLowerCase();
    const alpha = typeof v.alpha === "number" ? v.alpha : 1;
    if (alpha < 1) hex += to2(Math.round(alpha * 255));
    return hex;
  }
  return null;
}

function to2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

// Find a friendly swatch name for a hex value within the imported palette.
export function nameForHex(hex: string): string | null {
  const p = get(project);
  const h = (hex || "").toLowerCase();
  for (const g of p.colorGroups ?? [])
    for (const s of g.swatches) if (s.hex.toLowerCase() === h) return s.name;
  return null;
}
