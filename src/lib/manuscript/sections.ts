// Manuscript structure: section roles, and the export-time reordering a
// journal's published order needs.
//
// Flux has no structured section model — sections are plain markdown headings,
// which is right for writing. So roles are INFERRED by matching level-1 heading
// names against a venue's alias table. No new syntax, nothing for an author to
// maintain, and a heading that matches nothing is simply `body` — which is the
// NORMAL case for Nature, whose main text uses free-form descriptive subheads
// (0 of 61 sampled papers print an "Introduction" or "Results" heading).
//
// THE SOURCE IS NEVER REORDERED. Only the exported document is, and the preview
// renders the same reordered result, so `preview == export` still holds. Moving
// an author's prose on disk would break running references ("as described
// above"), churn comment anchors, and make the diff unreviewable.
//
// Twin-engine shared core (flux-core → src/lib): no Svelte, no DOM, no Node.

/** Roles a venue can order. `body` is anything unrecognised — the common case. */
export type SectionRole =
  | "body"
  | "abstract"
  | "discussion"
  | "methods"
  | "data-availability"
  | "code-availability"
  | "acknowledgements"
  | "funding"
  | "author-contributions"
  | "competing-interests"
  | "additional-information"
  | "references"
  | "figure-legends"
  | "methods-references"
  | "extended-data";

export interface SectionSpan {
  role: SectionRole;
  /** Heading text as authored, without the leading #s. "" for the preamble. */
  heading: string;
  level: number;
  /** Character offsets into the source: [from, to). */
  from: number;
  to: number;
  /** Word count of the section's body (heading excluded). */
  words: number;
}

export interface ManuscriptStructure {
  /** Everything before the first heading (title block, summary paragraph). */
  preamble: SectionSpan;
  sections: SectionSpan[];
}

/** Heading name → role. Lower-case, punctuation-trimmed keys. */
export type RoleAliases = Record<string, SectionRole>;

/** Nature's back matter is a fixed vocabulary, so name-matching is reliable
 *  exactly where ordering matters and silent exactly where it does not. */
export const NATURE_ROLE_ALIASES: RoleAliases = {
  methods: "methods",
  "materials and methods": "methods",
  "online methods": "methods",
  discussion: "discussion",
  "data availability": "data-availability",
  "code availability": "code-availability",
  acknowledgements: "acknowledgements",
  acknowledgments: "acknowledgements",
  funding: "funding",
  "author contributions": "author-contributions",
  contributions: "author-contributions",
  "competing interests": "competing-interests",
  "competing financial interests": "competing-interests",
  "declaration of interests": "competing-interests",
  "additional information": "additional-information",
  references: "references",
  "extended data": "extended-data",
};

const FENCE_RE = /^(\s*)(```+|~~~+)/;

/** Strip trailing punctuation and Quarto attributes from a heading for lookup. */
export function normalizeHeading(h: string): string {
  return h
    .replace(/\{[^}]*\}\s*$/, "") // {#sec-methods .unnumbered}
    .replace(/[:.\s]+$/, "")
    .trim()
    .toLowerCase();
}

function countWords(s: string): number {
  const m = s.replace(/[#*_`>|-]/g, " ").match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Scan a manuscript into role-tagged sections.
 *
 * Masks YAML front matter and fenced code the same way the citation scanner
 * does — a `# comment` inside a shell block is not a section heading.
 * A section runs from its heading to the next heading of the SAME or higher
 * level, so H2s nest inside their H1 rather than splitting it.
 */
export function scanSections(src: string, aliases: RoleAliases = {}): ManuscriptStructure {
  const lines = src.split("\n");
  // Offset of the start of each line, for span math.
  const offsets: number[] = [];
  let acc = 0;
  for (const l of lines) {
    offsets.push(acc);
    acc += l.length + 1;
  }

  let inFence: string | null = null;
  let inFrontMatter = false;
  const heads: { line: number; level: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^---\s*$/.test(line)) {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) inFrontMatter = false;
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      if (inFence && line.trim().startsWith(inFence)) inFence = null;
      else if (!inFence) inFence = f[2];
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) heads.push({ line: i, level: h[1].length, text: h[2].trim() });
  }

  const end = src.length;
  const preambleEnd = heads.length ? offsets[heads[0].line] : end;
  const preamble: SectionSpan = {
    role: "abstract",
    heading: "",
    level: 0,
    from: 0,
    to: preambleEnd,
    words: countWords(src.slice(0, preambleEnd)),
  };

  const sections: SectionSpan[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    // Extend to the next heading of the same-or-higher level (H2s stay inside).
    let j = i + 1;
    while (j < heads.length && heads[j].level > h.level) j++;
    const from = offsets[h.line];
    const to = j < heads.length ? offsets[heads[j].line] : end;
    const role = h.level === 1 ? (aliases[normalizeHeading(h.text)] ?? "body") : "body";
    sections.push({
      role,
      heading: h.text,
      level: h.level,
      from,
      to,
      words: countWords(src.slice(offsets[h.line] + lines[h.line].length, to)),
    });
  }
  return { preamble, sections };
}

/** Top-level sections only — the unit reordering moves. */
export function topLevelSections(st: ManuscriptStructure): SectionSpan[] {
  return st.sections.filter((s) => s.level === 1);
}

/**
 * Reorder a document's TOP-LEVEL sections into a venue's published order.
 *
 * Conservative by construction:
 *   • only sections whose role the venue names are moved;
 *   • everything unrecognised (`body`) keeps its relative order, as a block, in
 *     the position the venue gives `body`;
 *   • the preamble never moves;
 *   • when the source already matches, the text is returned UNCHANGED (===), so
 *     a no-op reorder cannot perturb bytes.
 */
export function reorderForExport(
  src: string,
  order: readonly string[],
  aliases: RoleAliases,
): { text: string; moved: string[] } {
  if (!order.length) return { text: src, moved: [] };
  const st = scanSections(src, aliases);
  const tops = topLevelSections(st);
  if (!tops.length) return { text: src, moved: [] };

  const rank = new Map<string, number>();
  order.forEach((r, i) => rank.set(r, i));
  const bodyRank = rank.get("body") ?? 0;
  // Roles the venue does not mention stay where they are relative to body.
  const rankOf = (s: SectionSpan) => rank.get(s.role) ?? bodyRank;

  // Stable sort: equal ranks keep authored order, so the body reads as written.
  const sorted = [...tops]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rankOf(a.s) - rankOf(b.s) || a.i - b.i)
    .map((x) => x.s);

  if (sorted.every((s, i) => s === tops[i])) return { text: src, moved: [] };

  const head = src.slice(0, tops[0].from);
  const text = head + sorted.map((s) => src.slice(s.from, s.to)).join("");
  const moved = sorted
    .filter((s, i) => s !== tops[i])
    .map((s) => s.heading);
  return { text, moved };
}
