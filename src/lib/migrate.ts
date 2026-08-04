// ---------------------------------------------------------------------------
// Project model migration — pure, idempotent, dependency-light (types + the
// pure groups helpers only).
//
// Every loader runs this on the parsed model so old documents open in the
// current shape: the GUI via store.normalizeProject, flux-core via
// loadFigModel, and the standalone .flux path via loadProject → normalize.
// Element-level checks (not version gating) make it tolerant of partially
// migrated or hand-edited files.
// ---------------------------------------------------------------------------

import type { Project, SemanticPlotElement, TextStyle } from "./types";
import { enforceZContiguity, gcGroups, nextGroupName } from "./groups";
import { applyFamilyNumbers, derivedFigureName, familyById, parseLegacyName } from "./figfamily";

// Seeded once per project when it has no textStyles at all (absent ≠ emptied:
// a user who deleted every style keeps their empty list). Fixed ids so
// addPanelLabel can link "ts-panel-label". Sizes are journal-spec canvas px
// (pt × 4/3): 8 pt bold panel letters, 7 pt body.
export const DEFAULT_TEXT_STYLES: TextStyle[] = [
  { id: "ts-panel-label", name: "Panel Label", fontFamily: "Arial", fontSize: 32 / 3, fontWeight: 700, fontStyle: "normal" },
  { id: "ts-body", name: "Body", fontFamily: "Arial", fontSize: 28 / 3, fontWeight: 400, fontStyle: "normal" },
];

/** Bring a loaded project up to model version 2. Mutates and returns `p`.
 *  - `type:"svg"` elements (the v1 opaque-`<image>` kind, deleted from the
 *    union) → `type:"plot"`: every SVG is a semantic plot now (figure-v1 P4 —
 *    a vanilla file gets a DERIVED manifest at cachePlot). Geometry/id/flags
 *    are untouched; `source.svgPath` is best-effort from the asset entry
 *    (provenance only — rendering keys off assetId); NO manifestPath, since
 *    sidecar presence is the fluxplot/vanilla discriminator and a legacy
 *    SvgElement never had one.
 *  - text `autoWidth` (v1 boolean) → `sizing` ("auto" | "fixed"); the legacy
 *    key is deleted. Already-migrated elements pass through untouched.
 *  - legacy FLAT groupIds (pre-P7, no registry entry) get a GroupDef
 *    synthesized ("Group N" by first-seen z-order), dangling parentIds are
 *    cleared, empty defs GC'd, and the z-contiguity invariant is enforced
 *    once per figure (groups.ts enforceZContiguity — stable, idempotent).
 *  - seeds the default named text styles when the project has none. */
export function migrateProject(p: Project): Project {
  for (const f of p.figures ?? []) {
    for (const e of f.elements ?? []) {
      if ((e as { type: string }).type === "svg") {
        const el = e as unknown as SemanticPlotElement;
        (el as { type: string }).type = "plot";
        if (!el.overrides) el.overrides = {};
        if (!el.source) {
          const asset = (p.assets ?? []).find((a) => a.id === el.assetId);
          el.source = { svgPath: asset?.path ?? "" };
        }
      }
      if (e.type !== "text") continue;
      const legacy = e as unknown as { autoWidth?: boolean; sizing?: unknown };
      if (legacy.sizing !== "auto" && legacy.sizing !== "auto-h" && legacy.sizing !== "fixed") {
        e.sizing = legacy.autoWidth === false ? "fixed" : "auto";
      }
      delete legacy.autoWidth;
    }
    // figure-v1 P7: group registry migration.
    for (const e of f.elements ?? []) {
      if (!e.groupId || f.groups?.[e.groupId]) continue;
      f.groups = f.groups ?? {};
      f.groups[e.groupId] = { id: e.groupId, name: nextGroupName(f) };
    }
    if (f.groups) {
      for (const g of Object.values(f.groups)) if (g.parentId && !f.groups[g.parentId]) delete g.parentId;
      gcGroups(f);
      enforceZContiguity(f);
    }
  }
  if (!Array.isArray(p.textStyles)) p.textStyles = structuredClone(DEFAULT_TEXT_STYLES);
  (p as { version: number }).version = 2;
  return p;
}

/** Per-figure hints from a fig/index.json written before (or alongside) the
 *  canvas files — index-side identity the canvas figure may predate. */
export interface FamilyHint {
  family?: string;
  number?: number;
  nickname?: string;
  kind?: string;
}

/** Build the per-figure hint map from a fig/index.json `figures` array (both
 *  engines' loaders call this with their parsed index). */
export function familyHintsFrom(
  figures?:
    | readonly { id: string; family?: string; number?: number; nickname?: string; kind?: string }[]
    | null,
): Map<string, FamilyHint> {
  const m = new Map<string, FamilyHint>();
  for (const f of figures ?? []) {
    m.set(f.id, {
      ...(f.family ? { family: f.family } : {}),
      ...(f.number != null ? { number: f.number } : {}),
      ...(f.nickname ? { nickname: f.nickname } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
    });
  }
  return m;
}

/** Figure-family migration (figfamily.ts) — deliberately NOT part of
 *  migrateProject: slide decks project through normalizeProject →
 *  migrateProject (slide/store.ts) and must never have their slides renamed
 *  "Figure N". Only fig-subsystem loaders call this. Pure, idempotent,
 *  feature-detected: figures that already carry a family pass through
 *  untouched (the trailing normalizer is a fixpoint on healed input).
 *
 *  Per figure lacking a family:
 *  1. index hints win (an agent may have hand-set family/number/nickname);
 *  2. a legacy index `kind: "supplementary"` seeds the supplementary family
 *     (agent-set kinds on descriptive-named figures must survive);
 *  3. else the legacy name is parsed ("Figure S2" → supplementary/2);
 *  4. else DEFAULT_FAMILY, appended in existing order.
 *  A descriptive name that didn't parse ("Growth curves") is preserved as the
 *  figure's nickname before the derived name overwrites it.
 *
 *  Returns true when anything changed. */
export function migrateFigureFamilies(
  p: Project,
  hints?: Map<string, FamilyHint>,
): boolean {
  let changed = false;
  for (const f of p.figures ?? []) {
    if (f.family) continue;
    const h = hints?.get(f.id);
    const parsed = parseLegacyName(f.name ?? "");
    const family =
      h?.family ?? (h?.kind === "supplementary" ? "supplementary" : parsed?.family);
    const number =
      h?.number ?? (parsed && (!family || parsed.family === family) ? parsed.number : undefined);
    if (family) f.family = family;
    if (number != null) f.number = number;
    const nickname = h?.nickname ?? (parsed ? undefined : f.name?.trim() || undefined);
    if (nickname && !f.nickname) {
      // Don't nickname a figure whose name is just the derived form of the
      // hinted identity ("Figure 2" hinted figure/2 parses; but a hinted
      // supplementary kind with name "Figure 3" would otherwise nickname it).
      const wouldDerive =
        f.family && f.number != null
          ? derivedFigureName(familyById(f.family, p.figureFamilies), f.number)
          : null;
      if (nickname !== wouldDerive) f.nickname = nickname;
    }
    changed = true;
  }
  const healed = applyFamilyNumbers(p.figures ?? [], p.figureFamilies);
  return changed || healed.length > 0;
}
