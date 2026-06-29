// Figure data for the manuscript: resolves @fig refs, numbers them, and renders
// figures to self-contained SVG (reusing figureToSvg) for hover cards + embeds.
// Reads fig/ from disk via readFigSource — never touches the figure-editor store
// (Flux_Paper_Plan.md B-data layer).

import { get, writable } from "svelte/store";
import type { Figure } from "../../../../lib/types";
import { figureToSvg } from "../../../../lib/export";
import { readFigSource } from "../../../../lib/project/figbridge";
import { tableNumber } from "./numbering";

export interface FigureRef {
  id: string;
  label: string; // e.g. "fig-growth" (includes the fig- prefix, Quarto-style)
  name: string;
  order: number;
  number: string; // display number, "1", "2", …
  canvas: string;
  caption: string;
}

export const figureRefs = writable<FigureRef[]>([]);

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
      number: String(i + 1),
      canvas: f.canvas,
      caption: f.caption,
    }));
  figureRefs.set(refs);
}

/** Resolve a `@fig-…` label, including sub-panel refs (`fig-x-a` → "1a"). */
export function resolveFigure(
  label: string,
): { ref: FigureRef; number: string; panel?: string } | null {
  const refs = get(figureRefs);
  const exact = refs.find((r) => r.label === label);
  if (exact) return { ref: exact, number: exact.number };
  // Table cross-refs are numbered inline (by the table renderer), not from the
  // figure project — resolve them against the numbering registry.
  if (label.startsWith("tbl-")) {
    const n = tableNumber(label);
    if (n != null) {
      return {
        ref: { id: "", label, name: "", order: n, number: String(n), canvas: "", caption: "" },
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
    for (const it of items) {
      const sm = /^([a-z])(?:-([a-z]))?$/.exec(it);
      if (!sm) {
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
}
