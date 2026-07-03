// Pure core for the citation hover preview (R4). Given a bibliography page's text
// items and a link annotation's destination point, extract the referenced entry's
// text (group items into lines, start at the line under the dest, accumulate until
// the next entry marker / caps), and fuzzy-match that text to the OpenAlex briefs in
// the references sidebar so the hover card can show a structured reference with
// actions instead of raw text. No pdf.js / DOM here — unit-tested by
// scripts/verify-r4-cite.ts.

export interface TextItemLike {
  str: string;
  /** PDF-space baseline coords (transform[4], transform[5]; bottom-origin y). */
  x: number;
  y: number;
}

export interface BibLine {
  x: number;
  y: number;
  text: string;
}

/** Group text items into visual lines (same baseline within tolerance), top → bottom. */
export function groupLines(items: TextItemLike[], yTol = 3): BibLine[] {
  const lines: { x: number; y: number; parts: { x: number; str: string }[] }[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const line = lines.find((l) => Math.abs(l.y - it.y) <= yTol);
    if (line) {
      line.parts.push({ x: it.x, str: it.str });
      line.x = Math.min(line.x, it.x);
    } else {
      lines.push({ x: it.x, y: it.y, parts: [{ x: it.x, str: it.str }] });
    }
  }
  return lines
    .sort((a, b) => b.y - a.y) // PDF y is bottom-origin: top of page first
    .map((l) => ({
      x: l.x,
      y: l.y,
      text: l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    }));
}

/** A line that starts a new bibliography entry: "[12] …", "12. …", "12 …". */
const ENTRY_MARKER = /^\s*(\[\d+\]|\d+\.(?=\s)|\d+(?=\s+[A-Z]))/;

/**
 * The bibliography entry at a link destination: start at the first line at/below the
 * dest point (XYZ dests give the TOP of the target view), accumulate continuation
 * lines in the same column until the next entry marker, a column jump, or the caps.
 */
export function extractBibEntryAt(
  items: TextItemLike[],
  destY: number | null,
  opts: { maxLines?: number; maxChars?: number; colTol?: number } = {},
): string {
  const { maxLines = 6, maxChars = 500, colTol = 60 } = opts;
  const lines = groupLines(items);
  if (!lines.length) return "";
  let startIdx = destY == null ? 0 : lines.findIndex((l) => l.y <= destY + 2);
  if (startIdx < 0) startIdx = lines.length - 1;
  const start = lines[startIdx];
  let out = start.text;
  for (let i = startIdx + 1; i < lines.length && i - startIdx < maxLines; i++) {
    const l = lines[i];
    if (ENTRY_MARKER.test(l.text)) break; // next entry
    if (Math.abs(l.x - start.x) > colTol && l.x < start.x - 5) break; // column jump
    if (out.length + l.text.length > maxChars) break;
    out += " " + l.text;
  }
  return out.trim();
}

// --- fuzzy match: extracted entry text ↔ the sidebar's OpenAlex briefs -------------

export interface BriefLike {
  openalexId: string;
  title: string;
  authors: string[];
  year?: number | string;
  doi?: string;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip combining marks (NFD accents)

const STOP = new Set(["with", "from", "that", "this", "into", "over", "under", "between", "their", "about"]);
const titleTokens = (t: string) => fold(t).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));

/**
 * Best brief for an extracted bibliography entry, or null under the threshold.
 * Signal: significant title-token containment, plus year and first-author-surname
 * bonuses. A DOI appearing verbatim in the text short-circuits to a full match.
 */
export function matchRefToBriefs<B extends BriefLike>(
  entryText: string,
  briefs: B[],
): { brief: B; score: number } | null {
  const text = fold(entryText);
  if (!text.trim() || !briefs.length) return null;
  let best: { brief: B; score: number } | null = null;
  for (const b of briefs) {
    if (b.doi && text.includes(fold(b.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")))) {
      return { brief: b, score: 1 };
    }
    const toks = titleTokens(b.title);
    if (!toks.length) continue;
    const hits = toks.filter((t) => text.includes(t)).length;
    let score = hits / toks.length;
    if (b.year && text.includes(String(b.year))) score += 0.15;
    const surname = fold(b.authors[0] ?? "").split(/\s+/).pop() ?? "";
    if (surname.length > 2 && text.includes(surname)) score += 0.15;
    if (!best || score > best.score) best = { brief: b, score };
  }
  return best && best.score >= 0.6 ? best : null;
}

/** What PdfView hands the reader when a link annotation is hovered (R4). `rect` is
 *  structurally a DOMRect (viewport coords) — typed loosely to keep this module pure. */
export interface CitePreviewRequest {
  kind: "internal" | "external";
  rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
  /** Extracted bibliography-entry text at the destination (internal links). */
  text?: string;
  destPage?: number;
  url?: string;
}

// --- outline --------------------------------------------------------------------------

export interface OutlineNodeLike {
  title: string;
  dest?: unknown;
  items?: OutlineNodeLike[];
}
export interface FlatOutlineItem {
  title: string;
  dest: unknown;
  depth: number;
}

/** Flatten pdf.js's recursive getOutline() tree for a simple indented list UI. */
export function flattenOutline(nodes: OutlineNodeLike[] | null | undefined, depth = 0): FlatOutlineItem[] {
  const out: FlatOutlineItem[] = [];
  for (const n of nodes ?? []) {
    out.push({ title: n.title ?? "", dest: n.dest, depth });
    out.push(...flattenOutline(n.items, depth + 1));
  }
  return out;
}
