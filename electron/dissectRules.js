// Dissection path rules — the contract between everything that touches plots/_dissections/:
// the Plot Importer (which must NOT list it), the project watcher (which routes it to its own
// subsystem instead of the plots re-sync sweep), the Dissect viewer (which lists and renders
// it), and the `list-dissections` verb. ONE definition, because a second copy is exactly how
// the supplement filter rotted — two regexes, silent drift, nothing to catch it.
//
// Dependency-free ESM under electron/, because the Electron main process runs unbundled and
// `src/` is excluded from the packaged app, so main can only load from here — and it must be
// ESM rather than .cjs since the renderer imports it too (Vite serves a source .cjs verbatim,
// so `module.exports` never runs in a browser). Renderer/flux-core import through the typed
// wrapper `src/lib/dissect/rules.ts`.
//
// The convention: a plot `plots/<rel>.<ext>` owns `plots/_dissections/<rel>/` — companion
// material (per-subject sub-plots, `_stats` CSVs, alternative analyses). Subfolders inside it
// are named dissection groups; loose files form the default group. The folder key mirrors the
// plot's plots/-relative path, so `plots/sub/charlie.svg` owns `plots/_dissections/sub/charlie/`.

/** The reserved folder name directly under plots/. */
export const DISSECT_DIRNAME = "_dissections";
/** Project-relative root of all dissection material. */
export const DISSECT_REL = "plots/_dissections";

/** Forward-slash normalize + collapse "./" segments + trim trailing slashes. */
function norm(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/\.(?=\/)/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/** True if a directory entry NAME is the dissections folder. The importer's skip rule:
 *  checked at every depth so even a hand-nested `_dissections` never pollutes search. */
export function isDissectDirName(name) {
  return String(name || "") === DISSECT_DIRNAME;
}

/** True if a PROJECT-relative path is inside plots/_dissections/ (the watcher's rule).
 *  Segment-exact: `plots/_dissectionsX/…` and `plots/foo_dissections/…` do NOT match. */
export function isDissectionProjectRel(rel) {
  const r = norm(rel);
  return r === DISSECT_REL || r.startsWith(DISSECT_REL + "/");
}

/** True if a plots/-relative path is inside _dissections/ (any depth, segment-exact). */
export function isDissectionPlotsRel(rel) {
  return ("/" + norm(rel) + "/").includes("/" + DISSECT_DIRNAME + "/");
}

/** Drop a trailing filename extension (".svg", ".fluxplot.json" drops ".json" only —
 *  callers pass plot paths, which carry a single extension). */
function stripExt(name) {
  return String(name || "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

function baseName(p) {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * The plot KEY: the plot's plots/-relative path with its extension dropped — the folder name
 * its dissections live under (`plots/_dissections/<key>/`).
 *
 * Accepts every shape `source.svgPath` takes in real projects (absolute from GUI import,
 * project-relative from headless import, bare filename from drag-drop) plus a plain asset
 * basename (pasted/snip PNGs have no source at all). A path that resolves under the project's
 * plots/ keys by its full relative path; anything else (external import, bare name) keys by
 * its basename — predictable, documented, and collision-free for the normal layout.
 *
 * Returns "" when nothing usable (empty input, a path inside _dissections/ itself, or a
 * traversal attempt).
 */
export function plotKeyFor(sourcePath, projectRoot) {
  let s = norm(sourcePath);
  if (!s) return "";
  const root = norm(projectRoot);
  if (root && (s === root || s.startsWith(root + "/"))) s = s.slice(root.length).replace(/^\/+/, "");
  let key;
  if (s.startsWith("plots/")) {
    const rel = s.slice("plots/".length);
    if (isDissectionPlotsRel(rel)) return ""; // dissection material has no dissections of its own
    key = stripExt(rel);
  } else {
    key = stripExt(baseName(s));
  }
  if (!key || key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "";
  return key;
}

/** plots/-relative folder for a key: `_dissections/<key>`. */
export function dissectionRootRelFor(key) {
  return `${DISSECT_DIRNAME}/${norm(key)}`;
}

export const DISSECT_IMAGE_RE = /\.(svg|png|jpe?g|gif|webp)$/i;
export const DISSECT_TABLE_RE = /\.(csv|tsv)$/i;
const SIDECAR_RE = /\.(fluxplot|recipe|snip)\.json$/i;

/**
 * What a file inside a dissection folder IS, for the viewer:
 *   "image"   → grid cell with zoom/pan detail
 *   "table"   → CSV/TSV rendered as a table
 *   "sidecar" → a plot's companion manifest/recipe/snip json (attached to its image, not listed)
 *   "other"   → listed by name only (no viewer yet)
 */
export function classifyDissectionFile(name) {
  const n = String(name || "");
  if (SIDECAR_RE.test(n)) return "sidecar";
  if (DISSECT_IMAGE_RE.test(n)) return "image";
  if (DISSECT_TABLE_RE.test(n)) return "table";
  return "other";
}
