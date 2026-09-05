// Figure-reference meaning follows the permanent figure/panel IDs. This core
// has no editor or filesystem dependencies and runs in both engines.
import type { Figure } from "../types";
import { figurePanels, panelKey } from "../captions";
import { createFigureReferenceResolver, FIGURE_REFERENCE_TOKEN_SOURCE } from "../figureReferences";
import { deriveFigureReferenceKey } from "./figureIdentity";

export interface FigureReferenceSnapshot {
  id: string;
  label: string;
  panels: string[];
  panelIds: string[];
}
export interface ReferenceReplacement { from: number; to: number; insert: string }
export interface ReferenceEditPlan { changes: ReferenceReplacement[]; conflicts: string[] }
export function snapshotFigureReferences(figures: readonly Figure[], index?: { figures: { id: string; label: string }[] } | null): FigureReferenceSnapshot[] {
  const labels = new Map(index?.figures.map((f) => [f.id, f.label]));
  return figures.map((f) => {
    const panels = figurePanels(f).filter((p) => p.id !== "__figure__");
    return { id: f.id, label: f.referenceKey || labels.get(f.id) || deriveFigureReferenceKey(f), panels: panels.map((p) => panelKey(p.label)), panelIds: panels.map((p) => p.id) };
  });
}

/** Keep source examples/code and HTML comments literal. Offsets always refer
 * to the original text, so an editor can apply every replacement atomically. */
export function figureReferenceTokens(text: string): { from: number; to: number; token: string; definition: boolean }[] {
  const hidden: { from: number; to: number }[] = [];
  let fence: { char: string; count: number; from: number } | null = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line[0]);
    if (!mark) continue;
    if (!fence) fence = { char: mark[1][0], count: mark[1].length, from: line.index! };
    else if (mark[1][0] === fence.char && mark[1].length >= fence.count && /^\s*$/.test(line[0].slice(mark[0].length))) {
      hidden.push({ from: fence.from, to: line.index! + line[0].length }); fence = null;
    }
  }
  if (fence) hidden.push({ from: fence.from, to: text.length });
  for (const m of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) hidden.push({ from: m.index!, to: m.index! + m[0].length });
  // Backtick strings cannot cross blank lines. Match equal-length delimiters
  // so literal single ticks inside a double-tick example remain protected.
  for (const m of text.matchAll(/(`+)([^`]*(?:`(?!`)[^`]*)*?)\1/g)) hidden.push({ from: m.index!, to: m.index! + m[0].length });
  hidden.sort((a, b) => a.from - b.from);
  const re = new RegExp(`${FIGURE_REFERENCE_TOKEN_SOURCE}|\\{#(fig-[A-Za-z0-9_-]+)`, "g");
  const out: ReturnType<typeof figureReferenceTokens> = [];
  let h = 0;
  for (const m of text.matchAll(re)) {
    const from = m.index!;
    while (h < hidden.length && hidden[h].to <= from) h++;
    if (h < hidden.length && hidden[h].from <= from) continue;
    let escapes = 0;
    for (let i = from - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    if (escapes % 2) continue;
    out.push({ from, to: from + m[0].length, token: m[1] || m[2], definition: !!m[2] });
  }
  return out;
}

export function changedReferenceFigures(before: readonly FigureReferenceSnapshot[], after: readonly FigureReferenceSnapshot[]): string[] {
  const next = new Map(after.map((f) => [f.id, f]));
  return before.filter((f) => {
    const n = next.get(f.id);
    // Whole-figure removal has its own usage-aware confirmation. Here only
    // surviving figures can accidentally retarget a panel reference.
    return n && JSON.stringify(f) !== JSON.stringify(n);
  }).map((f) => f.id);
}

function selectedPanelIds(spec: string, ref: FigureReferenceSnapshot): string[] | null {
  const ids: string[] = [];
  for (const piece of spec.split(",")) {
    const [first, last] = piece.split("-");
    const a = ref.panels.indexOf(first), b = last ? ref.panels.indexOf(last) : a;
    if (a < 0 || b < a) return null;
    ids.push(...ref.panelIds.slice(a, b + 1));
  }
  return [...new Set(ids)];
}

export function planFigureReferenceEdits(text: string, before: readonly FigureReferenceSnapshot[], after: readonly FigureReferenceSnapshot[]): ReferenceEditPlan {
  const changed = new Set(changedReferenceFigures(before, after));
  const next = new Map(after.map((f) => [f.id, f]));
  const resolveBefore = createFigureReferenceResolver(before), resolveAfter = createFigureReferenceResolver(after);
  const out: ReferenceEditPlan = { changes: [], conflicts: [] };
  for (const match of figureReferenceTokens(text)) {
    const old = resolveBefore(match.token);
    if (!old || !changed.has(old.ref.id)) continue;
    const n = next.get(old.ref.id)!;
    let token = n.label;
    if (old.panelSpec) {
      const ids = selectedPanelIds(old.panelSpec, old.ref);
      const keys = ids?.map((id) => n.panels[n.panelIds.indexOf(id)]);
      if (!ids || !keys || keys.some((key) => !key || !/^[a-z]\d*$/.test(key) || n.panels.filter((k) => k === key).length !== 1)) {
        out.conflicts.push(`@${match.token} references a removed or ambiguous panel; repair this reference or restore its panel before saving`);
        continue;
      }
      // Retain the user's range spelling when its meaning did not change.
      const priorIds = selectedPanelIds(old.panelSpec, n);
      const same = priorIds && priorIds.length === ids.length && priorIds.every((id, i) => id === ids[i]);
      token += `-${same ? old.panelSpec : keys.join(",")}`;
      const check = resolveAfter(token);
      if (check?.ref.id !== n.id || !check.panelSpec) {
        out.conflicts.push(`@${match.token} cannot follow its panel because @${token} is another figure's reference key`);
        continue;
      }
    }
    if (token !== match.token) out.changes.push({ from: match.from, to: match.to, insert: `${match.definition ? "{#" : "@"}${token}` });
  }
  return out;
}

export function applyReferenceReplacements(text: string, changes: readonly ReferenceReplacement[]): string {
  for (const c of [...changes].sort((a, b) => b.from - a.from)) text = text.slice(0, c.from) + c.insert + text.slice(c.to);
  return text;
}
