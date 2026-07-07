// Figure data for the manuscript: resolves @fig refs, numbers them, and renders
// figures to self-contained SVG (reusing figureToSvg) for hover cards + embeds.
// Reads fig/ from disk via readFigSource — never touches the figure-editor store
// (Flux_Paper_Plan.md B-data layer).

import { get, writable } from "svelte/store";
import type { Figure } from "../../../../lib/types";
import { figureToSvg } from "../../../../lib/export";
import { readFigSource } from "../../../../lib/project/figbridge";
import { fileBridge } from "../../../../lib/project/types";
import { EMBED_RE } from "../science/figureAttrs";
import { tableNumber } from "./numbering";
import { designationFromName } from "./figText";

export { panelSpec, figRefText, designationFromName, nameIsDesignation } from "./figText";

export interface FigureRef {
  id: string;
  label: string; // e.g. "fig-growth" (includes the fig- prefix, Quarto-style)
  name: string;
  order: number;
  number: string; // display number, "1", "2", …
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
const renderCache = new Map<string, string>();

export async function loadFigures(root: string | null): Promise<void> {
  if (!root) return; // demo / no project — leave whatever was seeded
  const src = await readFigSource(root);
  figuresById = src.figures;
  assetData = src.assetData;
  renderCache.clear();
  const refs = [...src.indexFigures]
    .sort((a, b) => a.order - b.order)
    .map((f, i) => ({
      id: f.id,
      label: f.label,
      name: f.name,
      order: f.order,
      // Flux-figure is the source of truth for the designation: a name that IS
      // one ("Figure 3" → "3", "Figure S2" → "S2") wins, so renaming there
      // relabels every chip/embed/hover/export live. Descriptive names fall
      // back to the order-based ordinal.
      number: designationFromName(f.name) ?? String(i + 1),
      canvas: f.canvas,
      caption: f.caption,
      panels: f.panels ?? [],
    }));
  figureRefs.set(refs);
}

/** Resolve a `@fig-…` label, including sub-panel refs (`fig-x-a` → "1a"). */
export function resolveFigure(
  label: string,
): { ref: FigureRef; number: string; panel?: string } | null {
  const exact = refByLabel.get(label);
  if (exact) return { ref: exact, number: exact.number };
  // Table cross-refs are numbered inline (by the table renderer), not from the
  // figure project — resolve them against the numbering registry.
  if (label.startsWith("tbl-")) {
    const n = tableNumber(label);
    if (n != null) {
      return {
        ref: { id: "", label, name: "", order: n, number: String(n), canvas: "", caption: "", panels: [] },
        number: String(n),
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
      return { ref: base, number: base.number + panel, panel };
    }
  }
  return null;
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
): void {
  figuresById = figs;
  assetData = data;
  renderCache.clear();
  figureRefs.set(refs);
}
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fluxSeedFigures = __seedFigures;
  (window as unknown as Record<string, unknown>).__fluxFigures = {
    refs: () => get(figureRefs),
    resolve: resolveFigure,
    reload: (root: string | null) => loadFigures(root),
  };
}
