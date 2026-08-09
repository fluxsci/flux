// Pure boundary detection shared by Paper's fast word lane and contextual
// sentence lane. Scientific prose has enough periods that punctuation alone is
// not a sentence boundary (Fig. 2, et al., e.g., J. Neurosci., 3.5 mm).

export type CorrectionBoundaryKind = "word" | "sentence" | "paragraph";

const ABBREVIATIONS = new Set([
  "al", "approx", "ca", "cf", "dept", "dr", "e.g", "eq", "eqs", "et", "etc",
  "fig", "figs", "i.e", "inc", "jr", "mr", "mrs", "ms", "no", "nos", "prof",
  "acad", "am", "ann", "biol", "br", "cell", "chem", "engl", "j", "med",
  "mol", "nat", "neurosci", "phys", "physiol", "proc", "ref", "refs", "rev",
  "sci", "sr", "st", "trans", "vs", "vol",
]);

const CLOSERS = /["'’”\])}]/;
const WORD_CHAR = /[\p{L}\p{M}\d_'’-]/u;

function previousNonCloser(text: string, boundary: number): number {
  let at = Math.max(0, Math.min(boundary, text.length)) - 1;
  while (at >= 0 && CLOSERS.test(text[at])) at -= 1;
  return at;
}

function tokenBeforePeriod(text: string, period: number): string {
  let from = period;
  while (from > 0 && /[\p{L}.]/u.test(text[from - 1])) from -= 1;
  return text.slice(from, period).replace(/^\.+|\.+$/g, "");
}

/** True when whitespace/newline at `boundary` completes a real sentence. */
export function isSentenceBoundaryAt(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary > text.length) return false;
  const at = previousNonCloser(text, boundary);
  if (at < 0 || !/[.!?]/.test(text[at])) return false;
  if (text[at] === "!" || text[at] === "?") return true;

  // A period directly between digits is decimal punctuation. The right-hand
  // digit may already exist when this helper is used for extraction.
  if (/\d/.test(text[at - 1] ?? "") && /\d/.test(text[at + 1] ?? "")) return false;

  const token = tokenBeforePeriod(text, at);
  const lower = token.toLocaleLowerCase();
  if (ABBREVIATIONS.has(lower)) return false;
  if (/^(?:[a-z]\.){1,3}[a-z]?$/i.test(lower + ".")) return false; // e.g. / i.e.
  if (/^[A-Z]$/.test(token)) return false; // author/journal initials: J. Neurosci.
  if (/\bet\s+al$/i.test(text.slice(Math.max(0, at - 12), at))) return false;

  return true;
}

/** Classify only user-typed inserted text; paste/programmatic callers opt out. */
export function classifyTypedBoundaries(
  newDocument: string,
  insertionFrom: number,
  inserted: string,
): Set<CorrectionBoundaryKind> {
  const out = new Set<CorrectionBoundaryKind>();
  for (let i = 0; i < inserted.length; i += 1) {
    const char = inserted[i];
    const pos = insertionFrom + i;
    if (/\s/.test(char)) {
      if (char === "\n" && newDocument[pos - 1] === "\n") out.add("paragraph");
      if (isSentenceBoundaryAt(newDocument, pos)) out.add("sentence");
      let before = pos - 1;
      while (before >= 0 && /["'’”\])}.,;:!?]/.test(newDocument[before])) before -= 1;
      if (before >= 0 && WORD_CHAR.test(newDocument[before])) out.add("word");
      continue;
    }
    if (/[,;:!?()[\]{}]/.test(char) && WORD_CHAR.test(newDocument[pos - 1] ?? "")) {
      out.add("word");
    }
  }
  return out;
}

export interface CorrectionTextWindow {
  from: number;
  to: number;
  text: string;
  /**
   * Window-relative sub-range this lane is answerable for. Everything outside
   * it is context the linter needs to read the language correctly, not text
   * the lane may correct. Absent when the whole window is in scope.
   */
  focus?: { from: number; to: number };
}

/** Walk back from `to` to the start of the sentence (or paragraph) containing it. */
function sentenceStartBefore(document: string, to: number, floor: number): number {
  let from = floor;
  for (let i = to - 1; i > floor; i -= 1) {
    if (document[i] === "\n" && document[i - 1] === "\n") {
      from = i + 1;
      break;
    }
    if (/\s/.test(document[i]) && isSentenceBoundaryAt(document, i)) {
      from = i + 1;
      break;
    }
  }
  while (from < to && /\s/.test(document[from])) from += 1;
  return from;
}

/** Locate the sentence ending immediately before `head`, using the same rules as scheduling. */
export function extractSentenceWindow(
  document: string,
  head: number,
  maxLength = 720,
): CorrectionTextWindow | null {
  let to = Math.max(0, Math.min(head, document.length));
  while (to > 0 && /\s/.test(document[to - 1])) to -= 1;
  if (!to) return null;
  const from = sentenceStartBefore(document, to, Math.max(0, to - maxLength));
  const text = document.slice(from, to);
  return /[\p{L}\p{M}]/u.test(text) ? { from, to, text } : null;
}

/**
 * Word-lane window: the sentence so far, FOCUSED on the final two completed
 * tokens. Only the focus is correctable — the same narrow scope this lane has
 * always had — but the linter is handed the whole sentence, because a linter
 * shown a bare two-token slice reports artifacts of where the slice was cut.
 * "experiments. These" makes "experiments" a lowercase sentence opener when in
 * the manuscript that word ENDS a sentence; "therefore treat" makes a
 * mid-sentence adverb a discourse marker owed a comma; "et al" makes both
 * halves of an abbreviation unknown words. None of those survive real context.
 */
export function extractCompletedWordWindow(
  document: string,
  head: number,
  maxLength = 320,
): CorrectionTextWindow | null {
  // The linted text keeps the punctuation the user just typed ("et al." lints
  // clean, "et al" does not); the focus still ends at the last completed word.
  let to = Math.max(0, Math.min(head, document.length));
  while (to > 0 && /\s/.test(document[to - 1])) to -= 1;
  let focusTo = to;
  while (focusTo > 0 && /[\s.,;:!?()[\]{}"'’”]/.test(document[focusTo - 1])) focusTo -= 1;
  if (!focusTo) return null;

  const floor = Math.max(0, focusTo - maxLength);
  let focusFrom = focusTo;
  let gaps = 0;
  while (focusFrom > floor) {
    const char = document[focusFrom - 1];
    if (char === "\n") break;
    if (/\s/.test(char)) {
      gaps += 1;
      if (gaps >= 2) break;
      while (focusFrom > floor && /\s/.test(document[focusFrom - 1])) focusFrom -= 1;
      continue;
    }
    focusFrom -= 1;
  }
  while (focusFrom < focusTo && /\s/.test(document[focusFrom])) focusFrom += 1;

  // A focus never crosses into the previous sentence: the two trailing tokens
  // can straddle a sentence boundary, and this lane owns only the current one.
  const from = sentenceStartBefore(document, focusTo, floor);
  focusFrom = Math.max(focusFrom, from);
  const text = document.slice(from, to);
  if (!/[\p{L}\p{M}]/u.test(document.slice(focusFrom, focusTo))) return null;
  return { from, to, text, focus: { from: focusFrom - from, to: focusTo - from } };
}

/**
 * True when a window beginning immediately after `before` opens a real sentence.
 * `before` is the document text preceding the window — a short slice is enough,
 * and an empty one means the window starts the document.
 */
export function windowStartsSentence(before: string): boolean {
  let at = before.length;
  while (at > 0 && /\s/.test(before[at - 1])) at -= 1;
  // Nothing but whitespace precedes it — document start, or a blank line.
  if (at === 0) return true;
  // A line break starts a new block: paragraph, list item, heading, table row.
  if (before.slice(at).includes("\n")) return true;
  return isSentenceBoundaryAt(before, at);
}

/**
 * Split a whole document into lintable backlog windows: paragraph blocks,
 * long paragraphs cut at sentence boundaries (whitespace as a fallback) so
 * every chunk stays within the size the worker lints during live typing.
 */
export function backlogScanWindows(document: string, maxLength = 640): CorrectionTextWindow[] {
  const out: CorrectionTextWindow[] = [];
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(document[from])) from += 1;
    while (to > from && /\s/.test(document[to - 1])) to -= 1;
    if (to <= from) return;
    const text = document.slice(from, to);
    if (/[\p{L}\p{M}]/u.test(text)) out.push({ from, to, text });
  };
  const pushParagraph = (from: number, to: number) => {
    let at = from;
    while (to - at > maxLength) {
      let cut = -1;
      for (let i = at + maxLength; i > at + maxLength / 2; i -= 1) {
        if (/\s/.test(document[i]) && isSentenceBoundaryAt(document, i)) {
          cut = i;
          break;
        }
      }
      if (cut < 0) {
        for (let i = at + maxLength; i > at + maxLength / 2; i -= 1) {
          if (/\s/.test(document[i])) {
            cut = i;
            break;
          }
        }
      }
      if (cut < 0) cut = at + maxLength;
      push(at, cut);
      at = cut;
    }
    push(at, to);
  };
  let from = 0;
  const separator = /\n[ \t]*\n+/g;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(document))) {
    pushParagraph(from, match.index);
    from = match.index + match[0].length;
  }
  pushParagraph(from, document.length);
  return out;
}

export const SCIENTIFIC_ABBREVIATIONS = Object.freeze([...ABBREVIATIONS].sort());
