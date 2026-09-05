// ---------------------------------------------------------------------------
// Plot source paths — ONE definition of what `SemanticPlotElement.source` means
// on disk and how to turn any stored shape back into a readable file.
//
// `types.ts` documents source.svgPath/manifestPath/recipePath as PROJECT-RELATIVE,
// but three import routes disagreed in practice (dissectRules.js says the same):
//   • GUI import (io.ts) stored the absolute file-picker path
//   • headless import stored a project-relative path
//   • drag-drop stored a bare filename
// Nothing looked broken, because the SVG bytes are copied into fig/assets/ and
// every render/export reads THAT. source.* is used only to find the file the
// plot came from — so a wrong value fails silently: plots/ hot-swap stops
// re-importing, the slide bridge can't reload the source, X-ray shows a path
// that isn't there. The trigger is any change of project root: syncing a
// project between machines, renaming its folder, restoring it elsewhere.
//
// The fix is two-sided and both sides live here:
//   WRITE  toProjectRelativeSource() at import + healPlotSources() on load, so
//          canvases become portable on the machine that owns the file.
//   READ   plotSourceCandidates() everywhere that opens a source, so canvases
//          that ALREADY travelled still resolve (and the bare drag-drop name,
//          which never resolved at all, now does).
//
// Pure and dependency-light on purpose: the renderer, flux-core (CLI/MCP
// render) and the verify tier all import it. No fs, no stores — callers own
// the existence probe, since each has its own bridge.
// ---------------------------------------------------------------------------

import type { Project, SemanticPlotElement } from "../types";
import { isAbsolutePath } from "../project/types";

/** Forward-slash normalize + collapse "./" segments + trim trailing slashes. */
function norm(p: string | null | undefined): string {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/\.(?=\/)/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function baseName(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/** The user-owned plot directory, as a path SEGMENT (leading + trailing slash
 *  so `/plots/` never matches `/myplots/` or `/plots_old/`). */
const PLOTS_SEG = "/plots/";

/** True if `abs` is the root itself or lives beneath it. Segment-exact. */
export function isUnderRoot(root: string | null | undefined, abs: string): boolean {
  const r = norm(root);
  const a = norm(abs);
  if (!r || !a) return false;
  return a === r || a.startsWith(r + "/");
}

/** A stored source path rewritten PROJECT-RELATIVE when it lives under `root`.
 *  Anything else — a relative path (already portable) or an absolute one from a
 *  genuinely external import — comes back normalized but otherwise intact, so
 *  this never destroys a path it doesn't understand. */
export function toProjectRelativeSource(root: string | null | undefined, stored: string): string {
  const s = norm(stored);
  const r = norm(root);
  if (!s || !r || !isAbsolutePath(s)) return s;
  return s.startsWith(r + "/") ? s.slice(r.length + 1) : s;
}

/** Every absolute path worth trying for a stored source, best candidate first.
 *  Callers probe these in order and take the first that exists.
 *
 *  Project-relative paths resolve against this root. A historical absolute
 *  in-project plots/ path prefers THIS project's re-anchored copy before the
 *  old path; explicit external links preserve their origin. Bare legacy names
 *  also try plots/<name>. Explicit nested paths never guess by basename. */
export function plotSourceCandidates(root: string | null | undefined, stored: string, opts: { external?: boolean } = {}): string[] {
  const s = norm(stored);
  const r = norm(root);
  if (!s) return [];
  const out: string[] = [];
  const push = (p: string): void => {
    const n = norm(p);
    if (n && !out.includes(n)) out.push(n);
  };

  // An old in-project absolute path must follow the MOVED project even if
  // its old checkout still exists. Explicit external links keep their origin.
  const relocated = r && isAbsolutePath(s) && !isUnderRoot(r, s) && !opts.external && s.includes(PLOTS_SEG);
  if (relocated) push(`${r}/plots/${s.slice(s.lastIndexOf(PLOTS_SEG) + PLOTS_SEG.length)}`);
  if (isAbsolutePath(s)) push(s);
  else if (r) push(`${r}/${s}`);
  if (opts.external && isAbsolutePath(s)) return out;

  if (r) {
    const i = s.lastIndexOf(PLOTS_SEG);
    if (i >= 0) push(`${r}/plots/${s.slice(i + PLOTS_SEG.length)}`);
    else if (s.startsWith("plots/")) push(`${r}/${s}`);
    // Only a legacy bare filename warrants the basename rescue. Guessing
    // one for an explicit nested path can silently bind a different plot.
    if (!s.includes("/")) push(`${r}/plots/${baseName(s)}`);
  }
  return out;
}

/** Sidecars follow the SVG that actually resolved. Standard siblings always
 * pair with that file; authored non-sibling metadata keeps its explicit path.
 * When a legacy project moves, sidecars under its old root move with it, so
 * old-checkout metadata can never silently accompany the new SVG. */
export function plotSidecarCandidates(root: string, source: NonNullable<SemanticPlotElement["source"]>, resolvedSvg: string, kind: "manifest" | "recipe"): string[] {
  const suffix = kind === "manifest" ? ".fluxplot.json" : ".recipe.json";
  const stored = kind === "manifest" ? source.manifestPath : source.recipePath;
  const adjacent = norm(resolvedSvg).replace(/\.svg$/i, suffix);
  if (!stored || norm(stored) === norm(source.svgPath).replace(/\.svg$/i, suffix)) return [adjacent];
  const origin = norm(source.svgPath), sidecar = norm(stored);
  if (!source.external && isAbsolutePath(origin) && !isUnderRoot(root, origin) && isUnderRoot(root, resolvedSvg)) {
    const anchor = origin.lastIndexOf(PLOTS_SEG);
    if (anchor >= 0 && isUnderRoot(origin.slice(0, anchor), sidecar)) {
      return [`${norm(root)}/${sidecar.slice(anchor + 1)}`];
    }
    // A relative custom path is portable as-is. An unrelated historical
    // absolute path cannot safely supply a relocated source's metadata.
    return plotSourceCandidates(root, sidecar, source).filter((p) => isUnderRoot(root, p));
  }
  return plotSourceCandidates(root, sidecar, source);
}

export interface LinkedSourceFiles { svgPath: string; manifestPath?: string; recipePath?: string }
/** All exact files worth probing, including absent paths whose later creation
 * must wake the watcher. Native owns validation, read grants and lifetimes. */
export function linkedSourceFiles(root: string, project: Project): LinkedSourceFiles[] {
  const files = new Map<string, LinkedSourceFiles>();
  for (const f of project.figures) for (const e of f.elements) {
    if (e.type !== "plot" || !e.source?.svgPath || e.source.frozen) continue;
    for (const svgPath of plotSourceCandidates(root, e.source.svgPath, e.source)) {
      const manifests = plotSidecarCandidates(root, e.source, svgPath, "manifest");
      const recipes = plotSidecarCandidates(root, e.source, svgPath, "recipe");
      for (const manifestPath of manifests.length ? manifests : [undefined]) for (const recipePath of recipes.length ? recipes : [undefined]) {
        const value = { svgPath, manifestPath, recipePath };
        files.set(JSON.stringify(value), value);
      }
    }
  }
  return [...files.values()];
}

const SOURCE_KEYS = ["svgPath", "manifestPath", "recipePath"] as const;

/** Rewrite every under-root absolute source path in a loaded project to its
 *  project-relative form. Pure, idempotent, string-only — deliberately NO fs:
 *  it heals on the machine that owns the files (where the path IS under root),
 *  which is precisely the machine whose next save makes the canvas portable.
 *  A canvas that already travelled is handled at READ time by
 *  plotSourceCandidates instead. Returns the number of fields changed. */
export function healPlotSources(p: Project, root: string | null | undefined): number {
  const r = norm(root);
  if (!r) return 0;
  let changed = 0;
  for (const f of p.figures ?? []) {
    for (const el of f.elements ?? []) {
      if (el.type !== "plot") continue;
      const src = (el as SemanticPlotElement).source;
      if (!src) continue;
      for (const k of SOURCE_KEYS) {
        const cur = src[k];
        if (typeof cur !== "string" || !cur) continue;
        const rel = toProjectRelativeSource(r, cur);
        if (rel && rel !== cur) {
          src[k] = rel;
          changed++;
        }
      }
    }
  }
  return changed;
}
