// Shared reference syntax for Figure, Paper, commands and publication export.
// Figure numbering is supplied by Figure; prose order has no role here.
export interface ReferenceTarget { label: string; panels?: readonly string[] }
export const FIGURE_REFERENCE_TOKEN_SOURCE = String.raw`@(fig-[A-Za-z0-9_-]+(?:,[A-Za-z]\d*(?:-[A-Za-z]\d*)?)*)`;
const PANEL_ATOM = String.raw`[A-Za-z]\d*`;
const PANEL_SPEC = new RegExp(`^${PANEL_ATOM}(?:-${PANEL_ATOM})?(?:,${PANEL_ATOM}(?:-${PANEL_ATOM})?)*$`);

export function parsePanelSpec(spec: string, knownPanels?: readonly string[]): string | null {
  if (!PANEL_SPEC.test(spec)) return null;
  if (knownPanels) {
    const known = new Set(knownPanels);
    if (spec.split(/[,-]/).some((p) => !known.has(p))) return null;
  }
  return spec;
}

/** Exact whole-figure labels take precedence, then the longest matching label.
 *  The map is compiled once per figure revision, not once per painted chip. */
export function createFigureReferenceResolver<T extends ReferenceTarget>(entries: Iterable<T>) {
  const exact = new Map<string, T>();
  for (const ref of entries) if (ref.label && !exact.has(ref.label)) exact.set(ref.label, ref);
  return (token: string): { ref: T; panelSpec?: string } | null => {
    const hit = exact.get(token);
    if (hit) return { ref: hit };
    for (let i = token.lastIndexOf("-"); i >= 4; i = token.lastIndexOf("-", i - 1)) {
      const ref = exact.get(token.slice(0, i));
      if (!ref) continue;
      const panelSpec = parsePanelSpec(token.slice(ref.label.length + 1), ref.panels);
      if (panelSpec) return { ref, panelSpec };
      // The longest prefix owns the token; an invalid panel must not fall
      // through to a shorter, different figure.
      return null;
    }
    return null;
  };
}

export interface FigureReferenceConflict {
  kind: "duplicate" | "panel-shadow";
  label: string;
  otherLabel: string;
}
export function figureReferenceConflicts(entries: readonly ReferenceTarget[]): FigureReferenceConflict[] {
  const result: FigureReferenceConflict[] = [];
  const seen = new Set<string>();
  const byLabel = new Map(entries.map((ref) => [ref.label, ref]));
  for (const ref of entries) {
    if (seen.has(ref.label)) result.push({ kind: "duplicate", label: ref.label, otherLabel: ref.label });
    seen.add(ref.label);
    for (let i = ref.label.indexOf("-", 4); i >= 0; i = ref.label.indexOf("-", i + 1)) {
      const base = byLabel.get(ref.label.slice(0, i));
      if (!base) continue;
      if (parsePanelSpec(ref.label.slice(base.label.length + 1), base.panels)) {
        result.push({ kind: "panel-shadow", label: ref.label, otherLabel: base.label });
      }
    }
  }
  return result;
}
