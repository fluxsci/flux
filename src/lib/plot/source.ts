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
 *  1. the stored path itself, when absolute — same machine, and the only way a
 *     deliberate external import (a plot living outside the project) resolves;
 *  2. `<root>/<stored>` for a relative path — the canonical shape;
 *  3. re-anchored at THIS project's plots/ — rescues a foreign absolute path
 *     (project synced to another machine, folder renamed, restored elsewhere);
 *  4. `<root>/plots/<basename>` — last resort, and what finally resolves the
 *     bare-filename shape that drag-drop has always written. */
export function plotSourceCandidates(root: string | null | undefined, stored: string): string[] {
  const s = norm(stored);
  const r = norm(root);
  if (!s) return [];
  const out: string[] = [];
  const push = (p: string): void => {
    const n = norm(p);
    if (n && !out.includes(n)) out.push(n);
  };

  if (isAbsolutePath(s)) push(s);
  else if (r) push(`${r}/${s}`);

  if (r) {
    const i = s.lastIndexOf(PLOTS_SEG);
    if (i >= 0) push(`${r}/plots/${s.slice(i + PLOTS_SEG.length)}`);
    else if (s.startsWith("plots/")) push(`${r}/${s}`);
    push(`${r}/plots/${baseName(s)}`);
  }
  return out;
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
