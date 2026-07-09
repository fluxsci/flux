// ---------------------------------------------------------------------------
// Project model migration — pure, idempotent, dependency-light (types only).
//
// Every loader runs this on the parsed model so old documents open in the
// current shape: the GUI via store.normalizeProject, flux-core via
// loadFigModel, and the standalone .flux path via loadProject → normalize.
// Element-level checks (not version gating) make it tolerant of partially
// migrated or hand-edited files.
// ---------------------------------------------------------------------------

import type { Project, TextStyle } from "./types";

// Seeded once per project when it has no textStyles at all (absent ≠ emptied:
// a user who deleted every style keeps their empty list). Fixed ids so
// addPanelLabel can link "ts-panel-label". Sizes are journal-spec canvas px
// (pt × 4/3): 8 pt bold panel letters, 7 pt body.
export const DEFAULT_TEXT_STYLES: TextStyle[] = [
  { id: "ts-panel-label", name: "Panel Label", fontFamily: "Arial", fontSize: 32 / 3, fontWeight: 700, fontStyle: "normal" },
  { id: "ts-body", name: "Body", fontFamily: "Arial", fontSize: 28 / 3, fontWeight: 400, fontStyle: "normal" },
];

/** Bring a loaded project up to model version 2. Mutates and returns `p`.
 *  - text `autoWidth` (v1 boolean) → `sizing` ("auto" | "fixed"); the legacy
 *    key is deleted. Already-migrated elements pass through untouched.
 *  - seeds the default named text styles when the project has none. */
export function migrateProject(p: Project): Project {
  for (const f of p.figures ?? []) {
    for (const e of f.elements ?? []) {
      if (e.type !== "text") continue;
      const legacy = e as unknown as { autoWidth?: boolean; sizing?: unknown };
      if (legacy.sizing !== "auto" && legacy.sizing !== "auto-h" && legacy.sizing !== "fixed") {
        e.sizing = legacy.autoWidth === false ? "fixed" : "auto";
      }
      delete legacy.autoWidth;
    }
  }
  if (!Array.isArray(p.textStyles)) p.textStyles = structuredClone(DEFAULT_TEXT_STYLES);
  (p as { version: number }).version = 2;
  return p;
}
