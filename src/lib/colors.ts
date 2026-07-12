import { writable, get } from "svelte/store";
import type { ColorGroup, ColorSwatch, Id, PartOverride } from "./types";
import { project, selection, partSelection, drawStyle, commit } from "./store";
import * as ops from "./ops";

// Whether palette clicks set fill or stroke.
export const colorTarget = writable<"fill" | "stroke">("fill");

// (FIG-15: the F/S "quick colour picker" store was dead — never wired to a key or a UI — and
// F is actually the FluxFig property menu. Removed the store; Help.svelte corrected to match.)

// Write a style override onto a specific plot PART or GROUP, keyed by its stable
// semantic id (e.g. "control.line", or a group id like "axis.x.tick-labels").
// Survives plot regeneration because the id is deterministic (spec §7). Undoable.
export function applyPartStyleTo(elementId: Id, partId: string, patch: PartOverride) {
  commit((p) => ops.setPartOverride(p, elementId, partId, patch));
}

// Write a style override onto the currently selected plot PART (the canvas
// drill-in selection). Used by the inspector + by ColorSearch via applyColor.
export function applyPartStyle(patch: PartOverride) {
  const ps = get(partSelection);
  if (ps) applyPartStyleTo(ps.elementId, ps.partId, patch);
}

// Apply a colour to the current selection (or to the draw style if nothing is
// selected, so the next shape uses it). When a plot PART is selected, the colour
// retargets to that part's override instead of the whole element.
//
// `hex` may be the literal "none" (the palette's None swatch): valid for shape
// fill/stroke, but guarded where it would only ever be a foot-gun — text colour
// (invisible text) and a line's paint via the FILL target (lines have no fill;
// only an explicit stroke-none may blank one).
export function applyColor(hex: string, target = get(colorTarget)) {
  const none = hex === "none";
  if (get(partSelection)) {
    applyPartStyle(target === "fill" ? { fill: hex } : { stroke: hex });
    return;
  }
  const sel = get(selection);
  if (sel.size === 0) {
    drawStyle.update((s) =>
      target === "fill"
        ? { ...s, fill: hex }
        : { ...s, stroke: hex, ...(none ? {} : { textColor: hex }) },
    );
    return;
  }
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements) {
        if (!sel.has(e.id)) continue;
        if (e.type === "text") {
          if (none) continue;
          e.color = hex;
          // a manual colour edit detaches a linked named style IF that style
          // defines a colour (ops.detachOnManualEdit no-ops otherwise)
          ops.detachOnManualEdit(p, e, ["color"]);
        } else if (e.type === "line") {
          if (none && target === "fill") continue;
          e.stroke = hex;
        } else if (e.type === "rect" || e.type === "ellipse" || e.type === "path") {
          if (target === "fill") e.fill = hex;
          else e.stroke = hex;
        }
      }
  });
}

export function addRecentColor(hex: string) {
  commit((p) => {
    p.palette = [hex, ...p.palette.filter((c) => c !== hex)].slice(0, 12);
  });
}

// Set per-element opacity (0..1) across the selection.
export function setOpacity(v: number) {
  const sel = get(selection);
  if (sel.size === 0) return;
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) e.opacity = v;
  });
}

// Set stroke width across the selection (elements that support it).
export function setStrokeWidth(v: number) {
  const sel = get(selection);
  if (sel.size === 0) return;
  commit((p) => {
    for (const f of p.figures)
      for (const e of f.elements)
        if (sel.has(e.id) && "strokeWidth" in e) e.strokeWidth = v;
  });
}

// Best-guess current colour of the selection for a given target, for seeding
// the full editor. Returns the first selected element's relevant colour.
export function currentColor(target: "fill" | "stroke"): string {
  const sel = get(selection);
  const p = get(project);
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
