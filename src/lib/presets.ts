// ---------------------------------------------------------------------------
// Design presets — the user's machine-global library of reusable designs,
// stored one JSON file per preset under <FluxConfig>/presets/designs/**
// (dev fixture: localStorage via memBridge).
//
// A preset is either ONE primitive (rect/ellipse/line/path) or a GROUP of
// primitives + text: elements are stored verbatim (original ids kept — group
// membership references them) plus the subtree of group definitions, exactly
// like the clipboard (keyboard.ts copySelected). Inserting clones with fresh
// element ids, remaps group identity through groups.ts cloneGroupsFor (the
// paste core), and guarantees a multi-element preset lands as ONE group —
// wrapping loose sets via ops.group — so it can be moved as a unit and broken
// apart with ungroup. Thumbnails come from the SAME elementToSvg the canvas
// and export use, so previews can never lie.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Element, GroupDef, Id } from "./types";
import { fileBridge } from "./project/types";
import { project, selection, activeFigureId, viewport, commit, newId } from "./store";
import { ancestorsOf, cloneGroupsFor, groupDefs } from "./groups";
import * as ops from "./ops";
import { elementToSvg } from "./export";
import { elementBBox, unionRect, type Rect } from "./geometry";

export interface DesignPreset {
  fluxPreset: 1;
  kind: "design";
  name: string;
  savedAt: string;
  /** Single-primitive form (v1 files; still written for single selections). */
  element?: Element;
  /** Group form: elements in z-order (original ids kept for group refs) + the
   *  group-definition subtree covering them. */
  elements?: Element[];
  groups?: Record<Id, GroupDef>;
}
export interface PresetEntry {
  rel: string;
  preset: DesignPreset;
}

/** Picker state: closed | insert mode | save mode (carrying the selection). */
export const presetPicker = writable<null | { mode: "insert" } | { mode: "save"; elementIds: Id[] }>(null);

// A SINGLE preset must be one of the four primitives; group presets also
// admit text (labels inside badges/brackets — the owner's examples).
const PRIMITIVES = new Set<string>(["rect", "ellipse", "line", "path"]);
const GROUPABLE = new Set<string>([...PRIMITIVES, "text"]);
export function presetable(el: Element | null | undefined): boolean {
  return !!el && PRIMITIVES.has(el.type);
}
/** Can this selection be saved as a preset? 1 primitive, or ≥2 of primitives+text. */
export function presetableSelection(els: Element[]): boolean {
  if (!els.length) return false;
  if (els.length === 1) return presetable(els[0]);
  return els.every((e) => GROUPABLE.has(e.type));
}

/** The preset's element list regardless of storage form. */
export function presetElements(p: DesignPreset): Element[] {
  if (p.elements?.length) return p.elements;
  return p.element ? [p.element] : [];
}

function sane(list: unknown): PresetEntry[] {
  if (!Array.isArray(list)) return [];
  const out: PresetEntry[] = [];
  for (const it of list) {
    const e = it as PresetEntry;
    if (!e || typeof e.rel !== "string") continue;
    const p = e.preset as DesignPreset | undefined;
    if (!p || p.fluxPreset !== 1 || p.kind !== "design" || typeof p.name !== "string") continue;
    const els = presetElements(p);
    if (!els.length) continue;
    if (els.length === 1 && !PRIMITIVES.has(els[0].type)) continue;
    if (els.length > 1 && !els.every((el) => GROUPABLE.has(el.type))) continue;
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

/** Save the elements with the given ids (usually the selection) as a preset.
 *  Elements are captured in FIGURE z-order with their group-def subtree
 *  (clipboard-copy semantics); ids are kept in the file and remapped at
 *  insert. Returns the rel on success. */
export async function saveDesignPreset(name: string, ids: Id[]): Promise<string | null> {
  const rel = presetRel(name);
  if (!rel || !ids.length) return null;
  const p = get(project);
  const fig = p.figures.find((f) => f.elements.some((e) => ids.includes(e.id)));
  if (!fig) return null;
  const idSet = new Set(ids);
  const els = fig.elements.filter((e) => idSet.has(e.id)).map((e) => structuredClone(e));
  if (!presetableSelection(els)) return null;
  for (const el of els) {
    if (el.type === "text") delete el.styleId; // project-local named styles don't travel
  }
  const defs: Record<Id, GroupDef> = {};
  for (const el of els)
    for (const gid of ancestorsOf(fig, el.groupId))
      if (!defs[gid]) defs[gid] = structuredClone(groupDefs(fig)[gid]);
  const baseName = rel.replace(/\.json$/i, "").split("/").pop() || "preset";
  const preset: DesignPreset =
    els.length === 1
      ? (() => {
          const one = els[0] as Element & { groupId?: string };
          delete one.groupId; // a lone primitive travels without its group
          return { fluxPreset: 1, kind: "design", name: baseName, savedAt: new Date().toISOString(), element: one };
        })()
      : { fluxPreset: 1, kind: "design", name: baseName, savedAt: new Date().toISOString(), elements: els, groups: defs };
  const ok = await fileBridge()?.writeDesignPreset?.(rel, preset);
  return ok ? rel : null;
}

export async function deleteDesignPreset(rel: string): Promise<boolean> {
  return (await fileBridge()?.deleteDesignPreset?.(rel)) ?? false;
}

/** SVG thumbnail data-URL for a preset card — rendered by the SAME
 *  elementToSvg as canvas/export (assets don't apply to primitives/text). */
export function presetThumb(els: Element[] | Element): string {
  const list = Array.isArray(els) ? els : [els];
  if (!list.length) return "data:image/svg+xml;utf8,";
  const boxes: Rect[] = list.map(elementBBox);
  const b = unionRect(boxes)!;
  let pad = 4;
  for (const el of list)
    if ("strokeWidth" in el && typeof el.strokeWidth === "number") pad = Math.max(pad, el.strokeWidth * 3);
  const vx = b.x - pad;
  const vy = b.y - pad;
  const vw = Math.max(1, b.w + 2 * pad);
  const vh = Math.max(1, b.h + 2 * pad);
  const body = list.map((el) => elementToSvg(el, () => undefined)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">` + body + `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

// Top-level group of an element under the given defs (undefined = loose).
function topGroup(defs: Record<Id, GroupDef>, gid: Id | undefined): Id | undefined {
  let cur = gid;
  const seen = new Set<Id>();
  while (cur && defs[cur]?.parentId && !seen.has(cur)) {
    seen.add(cur);
    cur = defs[cur].parentId;
  }
  return cur && defs[cur] ? cur : undefined;
}

/** Insert a preset into the active figure, centered in the current viewport
 *  (clamped to the figure), with fresh element ids and remapped group
 *  identity. Multi-element presets always land as ONE group (loose sets get
 *  wrapped), so the insert can be moved as a unit and ungrouped to break
 *  apart. Selects the inserted elements. Returns the new ids ([] = no figure). */
export function insertPreset(entry: PresetEntry, viewportPx?: { w: number; h: number }): Id[] {
  const p = get(project);
  const fig = p.figures.find((f) => f.id === get(activeFigureId)) ?? p.figures[0];
  if (!fig) return [];
  const src = presetElements(entry.preset).map((e) => structuredClone(e));
  if (!src.length) return [];

  // placement: viewport centre in figure-local coords (fallback: figure centre)
  const b = unionRect(src.map(elementBBox))!;
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

  // fresh identity: new element ids; group ids remapped via the paste core
  const remap = new Map<Id, Id>();
  const clonedDefs = cloneGroupsFor(entry.preset.groups, src, remap);
  const newIds: Id[] = [];
  for (const el of src) {
    (el as { id: Id }).id = newId(el.type);
    el.x += dx;
    el.y += dy;
    if (el.groupId) el.groupId = remap.get(el.groupId) ?? el.groupId;
    newIds.push(el.id);
  }
  commit((proj) => {
    const f = proj.figures.find((ff) => ff.id === fig.id);
    if (!f) return;
    if (Object.keys(clonedDefs).length) {
      f.groups = f.groups ?? {};
      Object.assign(f.groups, clonedDefs);
    }
    f.elements.push(...src);
    // one-unit guarantee: wrap loose multi-element inserts in a fresh group
    if (src.length > 1) {
      const defs = groupDefs(f);
      const tops = new Set(src.map((el) => topGroup(defs, el.groupId) ?? `el:${el.id}`));
      if (tops.size > 1) ops.group(proj, newIds);
    }
  });
  selection.set(new Set(newIds));
  return newIds;
}
