// ---------------------------------------------------------------------------
// Design presets — the user's machine-global library of reusable primitives
// (line / path / rect / ellipse), stored one JSON file per preset under
// <FluxConfig>/presets/designs/** (dev fixture: localStorage via memBridge).
//
// A preset stores ONE element verbatim minus identity (id/groupId), so it
// round-trips every style the primitive supports — dash, arrowheads, fills,
// "none" paints, bezier nodes — with zero schema of its own. Saving is the
// FluxFig menu's "save as preset…" (or the picker in save mode); inserting is
// Ctrl+P → the grid picker (PresetPicker.svelte). Thumbnails are built from
// the SAME elementToSvg the canvas/export use, so previews can never lie.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Element, Id } from "./types";
import { fileBridge } from "./project/types";
import { project, selection, activeFigureId, viewport, commit, newId } from "./store";
import { elementToSvg } from "./export";
import { elementBBox } from "./geometry";

export type PresetKind = "rect" | "ellipse" | "line" | "path";
export interface DesignPreset {
  fluxPreset: 1;
  kind: "design";
  name: string;
  savedAt: string;
  element: Element;
}
export interface PresetEntry {
  rel: string;
  preset: DesignPreset;
}

/** Picker state: closed | insert mode | save mode (carrying the element). */
export const presetPicker = writable<null | { mode: "insert" } | { mode: "save"; elementId: Id }>(null);

const PRESETABLE = new Set<string>(["rect", "ellipse", "line", "path"]);
export function presetable(el: Element | null | undefined): el is Element & { type: PresetKind } {
  return !!el && PRESETABLE.has(el.type);
}

function sane(list: unknown): PresetEntry[] {
  if (!Array.isArray(list)) return [];
  const out: PresetEntry[] = [];
  for (const it of list) {
    const e = it as PresetEntry;
    if (!e || typeof e.rel !== "string") continue;
    const p = e.preset as DesignPreset | undefined;
    if (!p || p.fluxPreset !== 1 || p.kind !== "design" || typeof p.name !== "string") continue;
    if (!p.element || !PRESETABLE.has((p.element as Element).type)) continue;
    out.push({ rel: e.rel, preset: p });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function listDesignPresets(): Promise<PresetEntry[]> {
  try {
    return sane(await fileBridge()?.readDesignPresets?.());
  } catch {
    return [];
  }
}

/** Normalize a user-typed name/path into the stored rel ("arrows/fancy.json").
 *  Slashes create folders; unsafe segments are stripped. Null = nothing left. */
export function presetRel(name: string): string | null {
  const segs = name
    .split("/")
    .map((s) => s.trim().replace(/[^\w .-]+/g, "").replace(/^\.+/, ""))
    .filter(Boolean);
  if (!segs.length) return null;
  return segs.join("/") + ".json";
}

/** Save an element as a preset. Identity (id/groupId) is stripped; geometry is
 *  kept verbatim (the insert re-places it anyway). Returns the rel on success. */
export async function saveDesignPreset(name: string, el: Element): Promise<string | null> {
  const rel = presetRel(name);
  if (!rel || !presetable(el)) return null;
  const clone = structuredClone(el) as Element & { groupId?: string };
  (clone as { id: string }).id = "";
  delete clone.groupId;
  const preset: DesignPreset = {
    fluxPreset: 1,
    kind: "design",
    name: rel.replace(/\.json$/i, "").split("/").pop() || "preset",
    savedAt: new Date().toISOString(),
    element: clone,
  };
  const ok = await fileBridge()?.writeDesignPreset?.(rel, preset);
  return ok ? rel : null;
}

export async function deleteDesignPreset(rel: string): Promise<boolean> {
  return (await fileBridge()?.deleteDesignPreset?.(rel)) ?? false;
}

/** SVG thumbnail data-URL for a preset card — rendered by the SAME
 *  elementToSvg as canvas/export (assets don't apply to the four primitives). */
export function presetThumb(el: Element): string {
  const b = elementBBox(el);
  const sw = "strokeWidth" in el && typeof el.strokeWidth === "number" ? el.strokeWidth : 2;
  const pad = Math.max(4, sw * 3); // room for stroke overhang + arrowheads
  const vx = b.x - pad;
  const vy = b.y - pad;
  const vw = Math.max(1, b.w + 2 * pad);
  const vh = Math.max(1, b.h + 2 * pad);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">` +
    elementToSvg(el, () => undefined) +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/** Insert a preset into the active figure, centered in the current viewport
 *  (clamped to the figure), with a fresh id. Selects the new element.
 *  Returns the new id, or null when no figure is active. */
export function insertPreset(entry: PresetEntry, viewportPx?: { w: number; h: number }): Id | null {
  const p = get(project);
  const fig = p.figures.find((f) => f.id === get(activeFigureId)) ?? p.figures[0];
  if (!fig) return null;
  const el = structuredClone(entry.preset.element) as Element;
  (el as { id: Id }).id = newId(el.type);
  const b = elementBBox(el);
  // target: the viewport centre in figure-local coords (fallback: figure centre)
  const vp = get(viewport);
  let cx = fig.width / 2;
  let cy = fig.height / 2;
  if (viewportPx && vp.zoom > 0) {
    cx = (viewportPx.w / 2 - vp.panX) / vp.zoom - fig.x;
    cy = (viewportPx.h / 2 - vp.panY) / vp.zoom - fig.y;
  }
  cx = Math.min(Math.max(cx, b.w / 2), Math.max(b.w / 2, fig.width - b.w / 2));
  cy = Math.min(Math.max(cy, b.h / 2), Math.max(b.h / 2, fig.height - b.h / 2));
  const dx = cx - (b.x + b.w / 2);
  const dy = cy - (b.y + b.h / 2);
  el.x += dx;
  el.y += dy;
  commit((proj) => {
    const f = proj.figures.find((ff) => ff.id === fig.id);
    f?.elements.push(el);
  });
  selection.set(new Set([el.id]));
  return el.id;
}
