// Figure data for the manuscript: resolves @fig refs, numbers them, and renders
// figures to self-contained SVG (reusing figureToSvg) for hover cards + embeds.
// Reads fig/ from disk via readFigSource — never touches the figure-editor store
// (Flux_Paper_Plan.md B-data layer).

import { get, writable } from "svelte/store";
import type { Figure, FigureFamilyDef } from "../../../../lib/types";
import { figureToSvg } from "../../../../lib/export";
import { readFigSource } from "../../../../lib/project/figbridge";
import { fileBridge } from "../../../../lib/project/types";
import { EMBED_RE } from "../science/figureAttrs";
import {
  familyById,
  familyRank,
  formatCaptionLabel,
  formatFamilyRef,
} from "../../../../lib/figfamily";

export { panelSpec, figRefText } from "./figText";

export interface FigureRef {
  id: string;
  label: string; // e.g. "fig-growth" (includes the fig- prefix, Quarto-style)
  name: string; // derived display name ("Supplementary Figure 4")
  nickname?: string; // free-text recognition aid (searched, shown dim)
  family: string; // family id; "tbl"/"eq" on the fabricated table/eq refs
  number: number; // position within family (figfamily.ts — contiguous 1..N)
  display: string; // whole-figure in-text text: "Fig. S4" / "Mov. 3" / "Table 2"
  captionLabel: string; // caption lead: "Figure S4 | " ("" for tbl/eq)
  order: number; // global index order (jump/sort secondary key)
  canvas: string;
  caption: string;
  panels: string[]; // ordered panel letters ["a","b",…]; [] if unknown (F7)
}

export const figureRefs = writable<FigureRef[]>([]);

// PAP-22: index refs by label so the cite/cross-ref chip widgets resolve in O(1) instead of a
// linear `find` per chip per rebuild (chips rebuild on every keystroke/scroll over the visible
// range). Kept in sync by subscribing to the store, so every set — load, seed — refreshes it.
let refByLabel = new Map<string, FigureRef>();
figureRefs.subscribe((refs) => {
  const m = new Map<string, FigureRef>();
  for (const r of refs) if (!m.has(r.label)) m.set(r.label, r); // first-match, mirrors find()
  refByLabel = m;
});

let figuresById: Record<string, Figure> = {};
let assetData: Record<string, string> = {};
// Custom family definitions from the project (built-ins live in figfamily.ts).
let familyDefs: FigureFamilyDef[] = [];
const renderCache = new Map<string, string>();

export async function loadFigures(root: string | null): Promise<void> {
  if (!root) return; // demo / no project — leave whatever was seeded
  const src = await readFigSource(root);
  figuresById = src.figures;
  assetData = src.assetData;
  familyDefs = src.families;
  renderCache.clear();
  // Flux-figure is the source of truth: identity is (family, number) —
  // structured fields healed by the loader, never parsed out of the name —
  // so renaming/renumbering there relabels every chip/embed/hover/export
  // live. Pickers/completions list main figures first, then supplementary,
  // extended-data, customs, each in number order.
  const refs = [...src.indexFigures]
    .sort(
      (a, b) =>
        familyRank(a.family, familyDefs) - familyRank(b.family, familyDefs) ||
        a.number - b.number,
    )
    .map((f) => {
      const def = familyById(f.family, familyDefs);
      return {
        id: f.id,
        label: f.label,
        name: f.name,
        ...(f.nickname ? { nickname: f.nickname } : {}),
        family: f.family,
        number: f.number,
        display: formatFamilyRef(def, f.number),
        captionLabel: formatCaptionLabel(def, f.number),
        order: f.order,
        canvas: f.canvas,
        caption: f.caption,
        panels: f.panels ?? [],
      };
    });
  figureRefs.set(refs);
}

/** Resolve a `@fig-…` label, including sub-panel refs (`fig-x-a` → "Fig. 1a").
 *  Returns the family-formatted in-text `display` text ("Fig. S4a–c", "Mov. 3",
 *  "Table 2") — figfamily templates own the wording, callers render it verbatim.
 *  WS-4.2: table/equation cross-refs resolve against the PER-EDITOR numbering
 *  instance passed in `nums` (chips/hover/caret thread it from the facet);
 *  callers that only ever see fig-… labels (render, materialize) omit it. */
export function resolveFigure(
  label: string,
  nums?: { tbl: Map<string, number>; eq: Map<string, number> },
): { ref: FigureRef; display: string; panel?: string } | null {
  const exact = refByLabel.get(label);
  if (exact) return { ref: exact, display: exact.display };
  // Table cross-refs are numbered inline (by the table renderer), not from the
  // figure project — resolve them against the numbering registry.
  if (label.startsWith("tbl-")) {
    const n = nums?.tbl.get(label);
    if (n != null) {
      const display = `Table ${n}`;
      return {
        ref: { id: "", label, name: "", family: "tbl", number: n, display, captionLabel: "", order: n, canvas: "", caption: "", panels: [] },
        display,
      };
    }
    return null;
  }
  // Equation cross-refs (2.1): labeled `$$ … $$ {#eq-id}` blocks number by
  // appearance (science/math.ts publishes the registry; the export scans the
  // same rule via science/refNumbers).
  if (label.startsWith("eq-")) {
    const n = nums?.eq.get(label);
    if (n != null) {
      const display = `Eq. ${n}`;
      return {
        ref: { id: "", label, name: "", family: "eq", number: n, display, captionLabel: "", order: n, canvas: "", caption: "", panels: [] },
        display,
      };
    }
    return null;
  }
  // Sub-panel refs: append a panel letter, range, or comma-list to a label.
  //   @fig-x-a      → "1a"      (single panel)
  //   @fig-x-a-c    → "1a–c"    (panel range, rendered with an en dash)
  //   @fig-x-a,c    → "1a,c"    (non-contiguous panels)
  //   @fig-x-a-c,e  → "1a–c,e"  (range + extra panel)
  // Match the LONGEST base figure label that is a prefix (figure ids can
  // themselves contain hyphens), then parse the remainder as the panel spec.
  const refs = get(figureRefs); // panel-prefix match can't use the exact-label index
  let base: FigureRef | undefined;
  for (const r of refs) {
    if (label.startsWith(r.label + "-") && (!base || r.label.length > base.label.length)) {
      base = r;
    }
  }
  if (base) {
    const suffix = label.slice(base.label.length + 1);
    const items = suffix.split(",");
    const parts: string[] = [];
    let ok = items.length > 0;
    // When the figure's real panel letters are known (F7), validate that every
    // referenced panel exists, so @fig-x-z (no panel z) stays unresolved.
    const known = base.panels.length > 0;
    for (const it of items) {
      const sm = /^([a-z])(?:-([a-z]))?$/.exec(it);
      if (!sm) {
        ok = false;
        break;
      }
      if (known && (!base.panels.includes(sm[1]) || (sm[2] && !base.panels.includes(sm[2])))) {
        ok = false;
        break;
      }
      parts.push(sm[2] ? `${sm[1]}–${sm[2]}` : sm[1]);
    }
    if (ok) {
      const panel = parts.join(",");
      return {
        ref: base,
        display: formatFamilyRef(familyById(base.family, familyDefs), base.number, panel),
        panel,
      };
    }
  }
  return null;
}

/** label → resolved family identity for the export transform (exportQmd.ts):
 *  the same numbers the editor shows, never re-derived from embed order. */
export function exportCtxFigures(): Map<string, { family: FigureFamilyDef; number: number }> {
  const out = new Map<string, { family: FigureFamilyDef; number: number }>();
  for (const r of get(figureRefs)) {
    if (!out.has(r.label)) {
      out.set(r.label, { family: familyById(r.family, familyDefs), number: r.number });
    }
  }
  return out;
}

export function renderFigureSvg(id: string): string | undefined {
  if (renderCache.has(id)) return renderCache.get(id);
  const fig = figuresById[id];
  if (!fig) return undefined;
  const svg = figureToSvg(fig, (aid) => assetData[aid]);
  renderCache.set(id, svg);
  return svg;
}

export function figureById(id: string): Figure | undefined {
  return figuresById[id];
}

/** Write fig/renders/<id>.svg for every figure embedded in `docText`. Quarto (the DOCX
 *  export — and any bare `quarto render`) reads these from DISK; the in-app preview/PDF
 *  inline from memory, and W8 deliberately keeps MB-scale renders OFF the autosave path —
 *  so exports regenerate them just-in-time from the live figure model. flux-core has a
 *  headless twin (materializeRenders in flux-core/index.ts) for agents/CI. */
export async function materializeRenders(
  root: string,
  docText: string,
): Promise<{ wrote: number; failed: string[] }> {
  const fb = fileBridge();
  let wrote = 0;
  const failed: string[] = [];
  if (!root || !fb) return { wrote, failed };
  const ids = new Set<string>();
  for (const line of docText.split("\n")) {
    const m = EMBED_RE.exec(line);
    if (!m) continue;
    const fromPath = /fig\/renders\/([A-Za-z0-9_-]+)\.svg$/.exec(m[2]);
    if (fromPath) ids.add(fromPath[1]);
    else {
      const r = resolveFigure(m[3]);
      if (r && r.ref.id) ids.add(r.ref.id);
    }
  }
  if (!ids.size) return { wrote, failed };
  try {
    await fb.mkdir(`${root}/fig/renders`);
  } catch {
    /* exists */
  }
  for (const id of ids) {
    const svg = renderFigureSvg(id);
    if (!svg) {
      failed.push(id);
      continue;
    }
    try {
      await fb.writeText(`${root}/fig/renders/${id}.svg`, svg);
      wrote++;
    } catch {
      failed.push(id);
    }
  }
  return { wrote, failed };
}

// Dev-only seed so the headless harness can exercise chips/hover without a
// project on disk (browser demo has no file bridge).
export function __seedFigures(
  refs: FigureRef[],
  figs: Record<string, Figure>,
  data: Record<string, string> = {},
  families: FigureFamilyDef[] = [],
): void {
  figuresById = figs;
  assetData = data;
  familyDefs = families;
  renderCache.clear();
  figureRefs.set(refs);
}
if (import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__fluxSeedFigures = __seedFigures;
  (window as unknown as Record<string, unknown>).__fluxFigures = {
    refs: () => get(figureRefs),
    resolve: resolveFigure,
    reload: (root: string | null) => loadFigures(root),
  };
}
