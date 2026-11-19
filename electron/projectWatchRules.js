// The project watcher's route table: which project paths the Electron main process watches,
// and which `fs:changed` subsystem each one reports as. The watch list and the classifier are
// BOTH derived from this one table, so a folder can never be routed without being watched.
// They used to be two hand-written lists in main.cjs: paper/ was routed to "manuscript" from
// 2026-09-06 but never added to the watch list, so agent edits to paper/*.qmd and its comment
// sidecars never reached the open app (fixed 2026-11-19; gate: verify-project-watch-rules.ts).
//
// Same siting rule as dissectRules.js: dependency-free ESM under electron/ (main loads it with a
// dynamic import at watch setup; the pure gate imports it directly).
import { documentRoots } from "./documentRoots.js";

/** @typedef {{ rel: string, subsystem: string, file?: true }} WatchRoute
 *  A project-relative folder whose contents report as `subsystem`, or with `file`, one file. */

/**
 * Fixed routes, matched before the document folders so a document folder nested inside one of
 * these keeps that folder's subsystem.
 * @type {ReadonlyArray<Readonly<WatchRoute>>}
 */
export const FIXED_WATCH_ROUTES = Object.freeze([
  { rel: "plots", subsystem: "plots" }, // refined to "dissections" / pruned for lighttable by main
  { rel: "fig", subsystem: "fig" },
  { rel: "references", subsystem: "references" },
  { rel: "slides", subsystem: "slides" }, // W10 (SLD-1)
  // Context docs (+ their comments sidecars) live-reload through the same chain as
  // manuscript docs; the renderer suffix-matches the active document.
  { rel: "Context", subsystem: "context" },
  { rel: ".meta/live/sessions", subsystem: "presence" },
  // The feedback ledger: agent resolutions live-refresh the open app.
  { rel: ".meta/feedback.ndjson", subsystem: "feedback", file: true },
]);

/** A document folder the watcher may add: a plain relative path inside the project, never the
 *  project root itself ("" for a legacy main at the top level) and never a dot folder.
 *  @param {string} rel */
export function isWatchableDocumentRoot(rel) {
  return typeof rel === "string" && rel !== "" &&
    rel.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.startsWith(".") && !/[\\:]/.test(part));
}

/**
 * The routes for one project. `manifest` is project.json, or null when it could not be read
 * (the standard paper/ + manuscript/ folders are watched regardless).
 * @param {{ documentRoot?: string, manuscript?: { path?: string, config?: string } } | null} manifest
 * @returns {WatchRoute[]}
 */
export function projectWatchRoutes(manifest) {
  const docs = documentRoots(manifest && typeof manifest === "object" ? manifest : {}).filter(isWatchableDocumentRoot);
  /** @type {WatchRoute[]} */
  const routes = FIXED_WATCH_ROUTES.map(r => ({ ...r }));
  for (const rel of docs) if (!routes.some(r => r.rel === rel)) routes.push({ rel, subsystem: "manuscript" });
  return routes;
}

/** The subsystem for a project-relative path ("/"-separated), or null when no route covers it.
 *  A folder route covers what is inside it (not the folder's own entry); a file route, itself.
 *  @param {ReadonlyArray<Readonly<WatchRoute>>} routes @param {string} rel */
export function routeProjectRel(routes, rel) {
  for (const r of routes) if (r.file ? rel === r.rel : rel.startsWith(r.rel + "/")) return r.subsystem;
  return null;
}

/** The project-relative paths to hand the watcher: exactly the routes, nothing else.
 *  @param {ReadonlyArray<Readonly<WatchRoute>>} routes */
export const watchTargetRels = routes => routes.map(r => r.rel);
