// ---------------------------------------------------------------------------
// Named text styles — the GUI glue around the pure ops verbs:
//
//   • the MACHINE-GLOBAL style library (FileBridge read/writeGlobalTextStyles;
//     Electron persists <userData>/textstyles.json, the dev fixture uses
//     localStorage). Library styles are reusable DEFINITIONS: applying one
//     COPIES it into the project's own textStyles first (copy-on-apply — no
//     live cross-project sync), then applies like any project style.
//   • applying styles to selections / plot PARTS (canvas-px → plot-unit
//     fontSize conversion) with the wrap-cache reflow the pure core can't do.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Id, TextStyle } from "./types";
import { fileBridge } from "./project/types";
import { project, commit } from "./store";
import { reflowTexts } from "./text";
import { plotDom } from "./plot/store";
import * as ops from "./ops";

// The machine-global library, loaded lazily (and after every write).
export const globalTextStyles = writable<TextStyle[]>([]);

function sane(list: unknown): TextStyle[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is TextStyle =>
      !!s && typeof s === "object" && typeof (s as TextStyle).id === "string" && typeof (s as TextStyle).name === "string",
  );
}

export async function loadGlobalTextStyles(): Promise<TextStyle[]> {
  try {
    const fb = fileBridge();
    const list = sane(await fb?.readGlobalTextStyles?.());
    globalTextStyles.set(list);
    return list;
  } catch {
    globalTextStyles.set([]);
    return [];
  }
}

/** Upsert a style (by id) into the machine-global library ("Save to library"). */
export async function saveStyleToLibrary(st: TextStyle): Promise<boolean> {
  const fb = fileBridge();
  if (!fb?.writeGlobalTextStyles) return false;
  try {
    const cur = sane(await fb.readGlobalTextStyles?.());
    const next = [...cur.filter((s) => s.id !== st.id), structuredClone(st)];
    await fb.writeGlobalTextStyles(next);
    globalTextStyles.set(next);
    return true;
  } catch {
    return false;
  }
}

/** Apply a PROJECT style to text elements (one undo entry, reflow included). */
export function applyProjectStyle(ids: Id[], styleId: Id): void {
  if (!ids.length) return;
  commit((p) => {
    ops.applyTextStyle(p, ids, styleId);
    reflowTexts(p, ids);
  });
}

/** Apply a LIBRARY style: copy-on-apply — the definition is copied into
 *  project.textStyles (same id; an existing project copy WINS so a project
 *  that diverged its copy keeps its version), then applied normally. */
export function applyLibraryStyle(ids: Id[], libStyle: TextStyle): void {
  if (!ids.length) return;
  commit((p) => {
    if (!p.textStyles?.some((s) => s.id === libStyle.id)) {
      ops.createTextStyle(p, structuredClone(libStyle));
    }
    ops.applyTextStyle(p, ids, libStyle.id);
    reflowTexts(p, ids);
  });
}

/** Canvas px per plot user unit for an asset: naturalWidth (CSS px) over the
 *  cached SVG root's viewBox width (falling back to the manifest-free width
 *  attr chain via naturalWidth itself → 1). matplotlib pt-viewBox plots give
 *  4/3 — an 8 pt style lands as fontSize 8 in plot units, true points. */
export function plotPxPerUnit(assetId: Id): number {
  const p = get(project);
  const asset = p.assets.find((a) => a.id === assetId);
  const natural = asset?.naturalWidth ?? 0;
  const root = plotDom.get(assetId);
  const vb = (root?.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : 0;
  if (natural > 0 && vbW > 0) return natural / vbW;
  return 1;
}

/** Apply a named style to a drilled plot PART: converts the style's canvas-px
 *  fontSize into the plot's own user units and writes a normal id-keyed part
 *  override (fontFamily/weight/style/underline/size). No styleId is persisted
 *  on parts — overrides are the part-level truth. */
export function applyTextStyleToPart(elementId: Id, partId: string, st: TextStyle): void {
  const k = (() => {
    const p = get(project);
    for (const f of p.figures)
      for (const e of f.elements)
        if (e.id === elementId && e.type === "plot") return plotPxPerUnit(e.assetId);
    return 1;
  })();
  commit((p) => {
    ops.setPartOverride(p, elementId, partId, {
      fontFamily: st.fontFamily,
      fontWeight: st.fontWeight,
      fontStyle: st.fontStyle,
      textDecoration: st.underline ? "underline" : "none",
      fontSize: st.fontSize / (k || 1),
    });
  });
}

/** All apply-targets for the style pickers: the project's styles + the global
 *  library minus definitions the project already carries (project wins). */
export function libraryOnly(projectStyles: TextStyle[] | undefined, lib: TextStyle[]): TextStyle[] {
  const have = new Set((projectStyles ?? []).map((s) => s.id));
  return lib.filter((s) => !have.has(s.id));
}
