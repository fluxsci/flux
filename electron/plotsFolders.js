// Reserved folders under plots/ — the contract between everything that has to decide whether
// a path under plots/ is COMPOSABLE CONTENT (plots you put in a figure) or COMPANION MATERIAL
// that Flux deliberately keeps out of the way: the Plot Importer (which hides it from browse
// rows and from search until you ask for it by name), the project watcher (which must not let
// an exploratory image dump masquerade as a plots re-sync), and the dissections walker.
//
// ONE definition, for the same reason dissectRules.js exists: a second copy of "which folders
// are special" is exactly how the supplement filter rotted — two regexes, silent drift,
// nothing to catch it.
//
// Same siting rule as dissectRules.js: dependency-free ESM under electron/, because the
// Electron main process runs unbundled and `src/` is excluded from the packaged app, so main
// can only load from here — and it must be ESM rather than .cjs since the renderer imports it
// too (Vite serves a source .cjs verbatim, so `module.exports` never runs in a browser).
// Renderer/flux-core import through the typed wrapper `src/lib/project/plotsFolders.ts`.
//
// Two reserved names today, both `_`-prefixed (the user's own folders are not):
//   _dissections — per-plot companion material; see dissectRules.js and the Dissect viewer.
//   _lighttable  — collections for the Lighttable image-set viewer: exploratory sweeps, often
//                  thousands of images, not one of which is a figure panel.
//
// "Reserved" means hidden, NOT unreachable: typing "_" in the Plot Importer surfaces them as
// enterable rows, and entering one scopes the search to that folder — so the material is
// deliberately searchable and importable, and never accidentally so.

import { DISSECT_DIRNAME } from "./dissectRules.js";

/** The reserved folder directly under plots/ that holds Lighttable collections. */
export const LIGHTTABLE_DIRNAME = "_lighttable";
/** Project-relative root of all Lighttable material. */
export const LIGHTTABLE_REL = "plots/_lighttable";

/** The reserved folders, in the order the importer offers them. `hint` is the one-line
 *  description shown beside the row when the user types "_". */
export const RESERVED_PLOT_FOLDERS = [
  { name: DISSECT_DIRNAME, hint: "per-plot companion material" },
  { name: LIGHTTABLE_DIRNAME, hint: "exploratory image sets" },
];

/** Just the names. */
export const RESERVED_PLOT_DIRNAMES = RESERVED_PLOT_FOLDERS.map((f) => f.name);

/** Forward-slash normalize + collapse "./" segments + trim trailing slashes. (A local copy of
 *  a generic path normalizer, not of a rule — the RULES live here once and only here.) */
function norm(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/\.(?=\/)/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/** True if a directory entry NAME is one of the reserved folders. Name-exact: `_lighttableX`
 *  and `lighttable` are ordinary folders. Checked at every depth by the importer, so even a
 *  hand-nested reserved name never pollutes a plain search. */
export function isReservedPlotDirName(name) {
  return RESERVED_PLOT_DIRNAMES.includes(String(name || ""));
}

/** True if a PROJECT-relative path is inside plots/_lighttable/ (the watcher's rule).
 *  Segment-exact: `plots/_lighttableX/…` and `plots/my_lighttable.png` do NOT match. */
export function isLighttableProjectRel(rel) {
  const r = norm(rel);
  return r === LIGHTTABLE_REL || r.startsWith(LIGHTTABLE_REL + "/");
}

/** The reserved folder a plots/-RELATIVE path sits under, as its bare name, or "" for ordinary
 *  content. This is the importer's scope rule: a non-empty answer means searches stay inside. */
export function reservedRootOfPlotsRel(rel) {
  const first = norm(rel).split("/")[0];
  return isReservedPlotDirName(first) ? first : "";
}
