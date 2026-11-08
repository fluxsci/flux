// Journal figure legends — the venue's legend form from Flux's composed caption.
//
// Flux composes a caption as "Whole-figure sentence(s). **a**, panel text **b**, …"
// (captions.ts composeCaption). Each venue sets that differently:
//   Nature  — **Fig. 1 | Title sentence.** Rest. **a**, text. **b**, text.
//   Science — **Fig. 1. Title sentence.** Rest. (**A**) text (**B**) text
//   Cell    — **Figure 1. Title sentence**            (no final full stop)
//             (A) text                                (each panel on its own line)
//   bioRxiv — **Figure 1. Title sentence.** Rest. **a**, text …
// Output is pandoc markdown for ONE legend paragraph (Cell's lines are hard
// line breaks inside it), so Word and PDF set it identically.
//
// Pure: no Svelte, no DOM, no Node.

import type { LegendSpec, PanelStyle } from "./journalStyle";

export interface ParsedCaption {
  /** Text before the first panel marker. */
  lead: string;
  panels: { letter: string; text: string }[];
}

/** Split a composed caption on its `**a**,` panel markers (also legacy `(a)`). */
export function parseComposedCaption(md: string): ParsedCaption {
  const text = md.replace(/\s+/g, " ").trim();
  const re = /(?:^|\s)\*\*([A-Za-z]\d*)\*\*\s*[,.:]\s*/g;
  const marks: { at: number; end: number; letter: string }[] = [];
  for (const m of text.matchAll(re)) marks.push({ at: m.index!, end: m.index! + m[0].length, letter: m[1] });
  if (!marks.length) return { lead: text, panels: [] };
  const panels = marks.map((m, i) => ({
    letter: m.letter,
    text: text.slice(m.end, i + 1 < marks.length ? marks[i + 1].at : text.length).trim(),
  }));
  return { lead: text.slice(0, marks[0].at).trim(), panels };
}

/** First sentence (the legend title) and the rest. A sentence ends at ". "
 *  followed by a capital, digit or markup — not at "e.g. " or "vs. ". */
export function splitTitleSentence(lead: string): { title: string; rest: string } {
  const s = lead.trim();
  const re = /([.!?])\s+(?=[A-Z0-9*(\[])/g;
  for (const m of s.matchAll(re)) {
    const before = s.slice(0, m.index! + 1);
    if (/\b(?:e\.g|i\.e|vs|cf|et al|Fig|Figs|ref|refs|approx|ca|no|Eq|Eqs)\.$/i.test(before)) continue;
    return { title: before.trim(), rest: s.slice(m.index! + m[0].length).trim() };
  }
  return { title: s, rest: "" };
}

function caseLetter(letter: string, p?: PanelStyle): string {
  if (!p) return letter;
  const l = letter[0];
  const rest = letter.slice(1);
  return (p.letterCase === "upper" ? l.toUpperCase() : l.toLowerCase()) + rest;
}

const withStop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * One legend paragraph in pandoc markdown. `label` is the family caption lead
 * without trailing separators' whitespace, e.g. "Fig. 1 |", "Fig. 1.", "Figure 1.".
 */
export function formatLegend(label: string, captionMd: string, spec: LegendSpec, panels?: PanelStyle): string {
  const { lead, panels: ps } = parseComposedCaption(captionMd);
  const { title, rest } = splitTitleSentence(lead);
  const lbl = label.trim();
  let t = title.trim();
  if (spec.titlePeriod === "strip") t = t.replace(/[.]+$/, "");
  else if (t) t = withStop(t);
  const head = spec.boldTitle ? `**${lbl}${t ? ` ${t}` : ""}**` : `**${lbl}**${t ? ` ${t}` : ""}`;
  const tail = rest ? ` ${rest}` : "";
  if (spec.panels === "parens-lines") {
    // Cell: the title line, then each panel on its own line (hard breaks).
    const lines = [head + tail, ...ps.map((p) => `(${caseLetter(p.letter, panels)}) ${p.text}`)];
    return lines.join("\\\n");
  }
  const body =
    spec.panels === "parens-bold"
      ? ps.map((p) => `(**${caseLetter(p.letter, panels)}**) ${p.text}`).join(" ")
      : ps.map((p) => `**${caseLetter(p.letter, panels)}**, ${p.text}`).join(" ");
  return `${head}${tail}${body ? ` ${body}` : ""}`.trim();
}
