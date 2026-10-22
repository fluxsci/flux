// The FOCUS PLOT — which plot the Plots rail's Dissections pane shows (gate:
// scripts/verify-plots-rail-focus.ts). Last writer wins between the canvas (a selection that
// resolves to a plot, or a pointer-down on one — re-clicking an already-selected plot changes no
// selection store, so without the press a gallery click could never be taken back) and the
// gallery (a tile click, a ⧉ chip, a keyboard move after a short settle).
//
// Sticky: clearing the selection keeps the last plot (the pane would otherwise blank on every
// Escape). Pinned: focus changes are ignored until unpinned.
//
// The ONE selection→plot ladder lives here (`resolvePlotElement`); the `d` hotkey
// (dissect/state.ts) and the rail both use it:
//   1. a drilled part → its owning plot element;
//   2. else the single selected element;
//   3. else, with several selected, the most recently added plot-like element.

import { get, writable } from "svelte/store";
import type { Element, Project } from "../types";
import type { PartSelection } from "../store";
import { plotKeyFor, isDissectionPlotsRel, DISSECT_DIRNAME } from "../dissect/rules";
import { fileBridge, joinPath } from "../project/types";

type AssetEl = Pick<Element, "id" | "type"> & { assetId?: string; source?: { svgPath?: string; external?: boolean } };

/** The plot-like element a selection points at, or null. */
export function resolvePlotElement(p: Pick<Project, "figures">, selection: Set<string>, part: PartSelection | null): AssetEl | null {
  if (part) {
    for (const f of p.figures) {
      const hit = f.elements.find((e) => e.id === part.elementId);
      if (hit && hit.type === "plot") return hit as AssetEl;
    }
  }
  if (selection.size === 1) {
    const id = [...selection][0];
    for (const f of p.figures) {
      const hit = f.elements.find((e) => e.id === id);
      if (hit) return hit as AssetEl;
    }
    return null;
  }
  if (selection.size > 1) {
    const ids = [...selection];
    for (let i = ids.length - 1; i >= 0; i--) {
      for (const f of p.figures) {
        const hit = f.elements.find((e) => e.id === ids[i]) as AssetEl | undefined;
        if (hit && (hit.type === "plot" || hit.type === "image") && hit.assetId) return hit;
      }
    }
  }
  return null;
}

export type FocusKind = "plot" | "external" | "sourceless" | "none";

/** What a plot-like element's dissections are keyed by. */
export interface FocusTarget {
  /** Dissection key (plots/-relative, sans extension); "" when there is none. */
  key: string;
  kind: FocusKind;
  /** What the pane header calls it. */
  name: string;
  /** Absolute path of the plot file, when known (for the header thumbnail). */
  abs?: string;
  /** A dissection FILE the focus came from (a placed per-subject panel): select it. */
  file?: { group: string; name: string };
}

const norm = (p: string) => String(p || "").replace(/\\/g, "/");
/** Absolute on any platform (`/x`, `C:/x`, `\\\\server` after norm). */
const isAbs = (p: string) => /^([a-zA-Z]:)?\//.test(p);
const baseName = (p: string) => norm(p).split("/").pop() ?? "";
const stripExt = (p: string) => p.replace(/\.[^./]+$/, "");

/**
 * Where a plot element's companion material lives. Pure except for `exists` (used only for a
 * dissection FILE, to tell `key/group/file` from a nested key with a loose file).
 *   external/library source (absolute path outside the project) → kind "external";
 *   no source (pasted image, snip) → the asset name's key, kind "sourceless" (the documented
 *   fallback, labelled as such);
 *   a source under plots/_dissections/<key>/… → the OWNER key, with that file selected.
 */
export async function focusTargetFor(
  el: AssetEl,
  root: string,
  assetName: string,
  exists: (abs: string) => Promise<boolean> = async (abs) => !!(await fileBridge()?.exists?.(abs)),
): Promise<FocusTarget> {
  const src = el.type === "plot" ? norm(el.source?.svgPath ?? "") : "";
  const r = norm(root).replace(/\/+$/, "");
  if (src) {
    const inside = !r ? !isAbs(src) : src.startsWith(r + "/") || !isAbs(src);
    if (el.source?.external || !inside) return { key: "", kind: "external", name: stripExt(baseName(src)), abs: src };
    const rel = src.startsWith(r + "/") ? src.slice(r.length + 1) : src.replace(/^\.\//, "");
    const abs = isAbs(src) ? src : r ? `${r}/${rel}` : rel;
    if (rel.startsWith("plots/") && isDissectionPlotsRel(rel.slice("plots/".length))) {
      const owner = await dissectionOwner(rel.slice("plots/".length + DISSECT_DIRNAME.length + 1), r, exists);
      if (owner) return { key: owner.key, kind: "plot", name: baseName(owner.key), abs: owner.abs, file: { group: owner.group, name: owner.file } };
      return { key: "", kind: "none", name: stripExt(baseName(rel)), abs };
    }
    const key = plotKeyFor(rel, r);
    return { key, kind: key ? "plot" : "none", name: baseName(key) || stripExt(baseName(rel)), abs };
  }
  const key = assetName ? plotKeyFor(assetName, r) : "";
  return { key, kind: key ? "sourceless" : "none", name: key ? baseName(key) : assetName || "Untitled" };
}

/** `a/b/file.svg` under _dissections: key `a/b` (loose file) or key `a` (group `b`) —
 *  whichever owner plot exists (`plots/<key>.<svg|png|glb>`); the loose reading first. */
async function dissectionOwner(rest: string, root: string, exists: (abs: string) => Promise<boolean>): Promise<{ key: string; group: string; file: string; abs: string } | null> {
  const parts = norm(rest).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const file = parts[parts.length - 1];
  const tries: { key: string; group: string }[] = [{ key: parts.slice(0, -1).join("/"), group: "" }];
  if (parts.length >= 3) tries.push({ key: parts.slice(0, -2).join("/"), group: parts[parts.length - 2] });
  for (const t of tries) {
    for (const ext of ["svg", "png", "glb"]) {
      const abs = joinPath(joinPath(root, "plots"), `${t.key}.${ext}`);
      if (await exists(abs)) return { key: t.key, group: t.group, file, abs };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------------------------

export interface FocusState {
  target: FocusTarget | null;
  /** Where the last focus came from. */
  source: "canvas" | "gallery" | null;
  /** The focus is the plot currently selected on the canvas (false once deselected: sticky). */
  live: boolean;
  pinned: boolean;
  /** Bumps on every accepted change (also re-focusing the same plot from a new source). */
  n: number;
}

export const focusPlot = writable<FocusState>({ target: null, source: null, live: false, pinned: false, n: 0 });

let gen = 0;

/** Offer a focus. Ignored while pinned. Same key from the same source = no change. */
export function offerFocus(target: FocusTarget | null, source: "canvas" | "gallery"): void {
  const cur = get(focusPlot);
  if (cur.pinned) return;
  if (!target) {
    // Sticky: keep the plot, just mark it as no longer the canvas selection.
    if (source === "canvas" && cur.live) focusPlot.set({ ...cur, live: false });
    return;
  }
  const same = cur.target?.key === target.key && cur.target?.kind === target.kind && cur.target?.abs === target.abs
    && cur.target?.file?.name === target.file?.name && cur.target?.file?.group === target.file?.group;
  if (same && cur.source === source && cur.live === (source === "canvas")) return;
  focusPlot.set({ target, source, live: source === "canvas", pinned: false, n: cur.n + 1 });
}

/** Resolve an element asynchronously and offer it; a newer offer supersedes an older one. */
export async function offerElement(el: AssetEl | null, root: string, assetName: string, source: "canvas" | "gallery"): Promise<void> {
  const mine = ++gen;
  if (!el || !("assetId" in el) || !el.assetId) { offerFocus(null, source); return; }
  const t = await focusTargetFor(el, root, assetName);
  if (mine !== gen) return;
  offerFocus(t, source);
}

/** A gallery tile: its file IS the plot. */
export function offerFile(abs: string, root: string, scope: "project" | "global"): void {
  ++gen;
  const r = norm(root).replace(/\/+$/, "");
  const name = stripExt(baseName(abs));
  if (scope === "global" || !r || !norm(abs).startsWith(r + "/")) { offerFocus({ key: "", kind: "external", name, abs }, "gallery"); return; }
  const rel = norm(abs).slice(r.length + 1);
  if (rel.startsWith("plots/") && isDissectionPlotsRel(rel.slice("plots/".length))) {
    const mine = gen;
    void dissectionOwner(rel.slice("plots/".length + DISSECT_DIRNAME.length + 1), r, async (p) => !!(await fileBridge()?.exists?.(p))).then((o) => {
      if (mine !== gen) return;
      offerFocus(o ? { key: o.key, kind: "plot", name: baseName(o.key), abs: o.abs, file: { group: o.group, name: o.file } } : { key: "", kind: "none", name, abs }, "gallery");
    });
    return;
  }
  const key = plotKeyFor(rel, r);
  offerFocus({ key, kind: key ? "plot" : "none", name: key ? baseName(key) : name, abs }, "gallery");
}

export function setPinned(pinned: boolean): void {
  focusPlot.update((s) => ({ ...s, pinned }));
}

/** Forget the focus (project change). */
export function resetFocus(): void {
  ++gen;
  focusPlot.set({ target: null, source: null, live: false, pinned: false, n: get(focusPlot).n + 1 });
}
