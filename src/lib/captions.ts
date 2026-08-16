// Caption panels: a figure's captions are one-per-panel, where panels are the
// text elements the user has explicitly marked as panel labels (Alt+L / the
// inspector toggle — TextElement.panelLabel). Caption text is stored on
// Figure.captions keyed by the label element's id (see CaptionEditor).

import type { Figure, Id } from "./types";

export interface Panel {
  /** The label element's id, or "__figure__" for the whole-figure fallback. */
  id: Id;
  /** The displayed label ("" for the fallback). */
  label: string;
}

/** Normalised key for sorting labels (strip wrappers, lowercase). */
function sortKey(label: string): string {
  return label.replace(/[().]/g, "").trim().toLowerCase();
}

/**
 * Derive the caption panels for a figure: one per text element marked as a
 * panel label, sorted by label (a, b, c, …). If nothing is marked, fall back
 * to a single whole-figure caption.
 */
export function figurePanels(fig: Figure): Panel[] {
  const panels: Panel[] = [];
  for (const e of fig.elements) {
    if (e.type === "text" && e.panelLabel) {
      panels.push({ id: e.id, label: e.text.trim() });
    }
  }
  panels.sort(
    (a, b) => sortKey(a.label).localeCompare(sortKey(b.label)) || a.label.localeCompare(b.label),
  );
  if (panels.length === 0) return [{ id: "__figure__", label: "" }];
  return panels;
}

/** Normalised panel letter for sub-panel refs: "(A)" / "a." → "a". */
export function panelKey(label: string): string {
  return label.replace(/[().\s]/g, "").toLowerCase();
}

/** Whether a figure has explicit panel labels (vs. the whole-figure fallback). */
function hasPanels(fig: Figure): boolean {
  const ps = figurePanels(fig);
  return !(ps.length === 1 && ps[0].id === "__figure__");
}

/** Ordered, normalised panel letters for a figure (["a","b",…]); [] if none. */
export function panelLetters(fig: Figure): string[] {
  if (!hasPanels(fig)) return [];
  return figurePanels(fig)
    .map((p) => panelKey(p.label))
    .filter(Boolean);
}

/**
 * Editor blocks for the Caption Editor: a leading whole-figure block (the
 * caption's overall sentence) followed by one block per panel label. With no
 * panels it is just the single whole-figure block. (F7.)
 */
export function captionBlocks(fig: Figure): Panel[] {
  const blocks: Panel[] = [{ id: "__figure__", label: "Figure" }];
  if (hasPanels(fig)) for (const p of figurePanels(fig)) blocks.push(p);
  return blocks;
}

/**
 * Compose a figure's full caption markdown from its blocks — the single source
 * that flows Figure → fig/captions/<id>.md → Manuscript (F7). The whole-figure
 * sentence leads; each non-empty panel follows as "**a**, text" (bold letter +
 * comma, journal style — the owner's requested format; no parentheses).
 */
export function composeCaption(fig: Figure): string {
  const caps = fig.captions ?? {};
  const lead = (caps["__figure__"] ?? "").trim();
  if (!hasPanels(fig)) return lead;
  const parts: string[] = [];
  if (lead) parts.push(lead);
  for (const p of figurePanels(fig)) {
    const t = (caps[p.id] ?? "").trim();
    if (t) parts.push(`**${panelKey(p.label) || p.label.trim()}**, ${t}`);
  }
  return parts.join(" ");
}

/**
 * Inverse of composeCaption for the `set-caption` verb: split one monolithic
 * caption string on the documented `**a**, …` convention (also tolerating
 * legacy "(a) …") into the whole-figure lead + per-panel texts, keyed by the
 * figure's ACTUAL panel labels. Text for letters the figure doesn't have stays
 * in the lead (never silently dropped). Returns null when the string has no
 * panel markers matching the figure — caller stores it whole in __figure__.
 */
export function splitCaption(fig: Figure, md: string): Record<Id, string> | null {
  const panels = figurePanels(fig).filter((p) => p.id !== "__figure__");
  if (!panels.length) return null;
  const byKey = new Map(panels.map((p) => [panelKey(p.label), p.id] as const));
  const order = new Map(panels.map((p, i) => [panelKey(p.label), i] as const));
  // A panel marker: `**a**,` / `**a**.` / `**a**:` or legacy `(a)` at a
  // sentence boundary (start or after whitespace). Markers must appear in
  // panel order (a before b before c …) — a mid-text back-reference like
  // "(see (a))" inside panel c's text is NOT a marker.
  const markers: { idx: number; len: number; key: string }[] = [];
  // The letter may carry a sub-number (`**b1**,`) for multi-part figures whose panel b is
  // itself b1..b5 — panelLetters returns those names verbatim, so a caption that marks them
  // must be splittable too. False positives are impossible: every candidate is discarded
  // below unless `order` knows it as one of THIS figure's actual panels.
  const re = /(^|\s)(?:\*\*([A-Za-z]\d*)\*\*\s*[,.:]?|\(([A-Za-z]\d*)\))\s*/g;
  let lastOrder = -1;
  for (const m of md.matchAll(re)) {
    const key = (m[2] ?? m[3] ?? "").toLowerCase();
    const ord = order.get(key);
    if (ord === undefined || ord <= lastOrder) continue;
    lastOrder = ord;
    markers.push({ idx: (m.index ?? 0) + m[1].length, len: m[0].length - m[1].length, key });
  }
  if (!markers.length) return null;
  const out: Record<Id, string> = {
    __figure__: md.slice(0, markers[0].idx).trim(),
  };
  markers.forEach((mk, i) => {
    const end = i + 1 < markers.length ? markers[i + 1].idx : md.length;
    out[byKey.get(mk.key)!] = md.slice(mk.idx + mk.len, end).trim();
  });
  return out;
}
