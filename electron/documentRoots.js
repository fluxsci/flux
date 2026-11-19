// Where a project keeps its Paper documents: the ONE definition, read by document discovery
// (src/lib/project/documentFiles.ts, which both the renderer and flux-core use) and by the
// Electron project watcher (projectWatchRules.js), so the folders Paper lists and the folders
// the watcher reports changes in can never drift apart again. Until 2026-11-19 the watcher
// listed its folders by hand and omitted paper/, so agent edits to new-layout projects never
// reached the open app.
//
// Same siting rule as dissectRules.js: dependency-free ESM under electron/, because the
// Electron main process runs unbundled and `src/` is excluded from the packaged app, so main
// can only load from here — and it must be ESM rather than .cjs since the renderer imports it
// too (Vite serves a source .cjs verbatim, so `module.exports` never runs in a browser).

/** Folders always searched for documents: the current layout's paper/ and the legacy manuscript/. */
export const STANDARD_DOCUMENT_ROOTS = Object.freeze(["paper", "manuscript"]);

/** The directory part of a project-relative path ("" for a top-level file). */
export const parentDir = (/** @type {string} */ rel) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));

/**
 * The project's own document folder: `documentRoot` in project.json, or for a manifest written
 * before that field existed, the folder of its manuscript config or main document.
 * @param {{ documentRoot?: string, manuscript?: { path?: string, config?: string } }} m
 * @returns {string}
 */
export function documentRoot(m) {
  if (typeof m.documentRoot === "string") return m.documentRoot;
  const config = m.manuscript?.config, main = m.manuscript?.path ?? "";
  return config ? parentDir(config) : parentDir(main);
}

/**
 * Every folder Paper discovers documents under (Context/ aside, which has its own role), in
 * discovery order and without repeats. May include "" when a legacy main sits at the project
 * root; callers that watch folders must not treat that as "watch the whole project".
 * @param {{ documentRoot?: string, manuscript?: { path?: string, config?: string } }} m
 * @returns {string[]}
 */
export function documentRoots(m) {
  return [...new Set([documentRoot(m), ...STANDARD_DOCUMENT_ROOTS])];
}
