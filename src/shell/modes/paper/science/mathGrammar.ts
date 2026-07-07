// The ONE math grammar (2.1) — pure string scanning shared by the editor chips
// (inline math), the display-math block field, the renderer/export (placeholder
// extraction), and citeNumbering's masking (ordinal parity requires the citation
// scanner to skip exactly the spans the renderer stops transforming). Pandoc's
// `$`-math rules, no dependencies, tsx-testable.
//
//   inline  `$…$`  — the opener `$` must be followed by a non-space; the closer `$`
//                    must be preceded by a non-space and NOT followed by a digit
//                    ("costs $5 and $10 more" stays prose); `\$` never opens/closes;
//                    `$$` never matches the inline rule; pairing is left-to-right,
//                    non-overlapping, single-line.
//   display `$$…$$` — a line whose trimmed text STARTS with `$$` opens a block; the
//                    line whose trimmed text ENDS with `$$` (± a `{#eq-id}` label)
//                    closes it; single-line `$$…$$ {#eq-id}` supported. Labels ride
//                    the CLOSING line (Quarto syntax); numbering is appearance-order
//                    over LABELED equations only (science/refNumbers.ts).

export interface InlineMathSpan {
  from: number; // index of the opening $
  to: number; // index AFTER the closing $
  tex: string; // contents between the dollars
}

/** Every inline `$…$` span in one line/segment of prose (never crosses lines). */
export function findInlineMath(text: string): InlineMathSpan[] {
  const out: InlineMathSpan[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2; // skip escaped anything (incl. \$)
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    // `$$` never opens INLINE math.
    if (text[i + 1] === "$") {
      i += 2;
      continue;
    }
    // Opener must be followed by non-space.
    const next = text[i + 1];
    if (next === undefined || /\s/.test(next)) {
      i++;
      continue;
    }
    // Find a valid closer.
    let j = i + 1;
    let close = -1;
    while (j < n) {
      const cj = text[j];
      if (cj === "\\") {
        j += 2;
        continue;
      }
      if (cj === "$") {
        const prev = text[j - 1];
        const after = text[j + 1];
        if (!/\s/.test(prev) && !(after !== undefined && /\d/.test(after)) && after !== "$") {
          close = j;
          break;
        }
        // `$$` inside — not a valid inline closer either way.
        if (after === "$") j++;
      }
      j++;
    }
    if (close < 0) {
      i++;
      continue;
    }
    const tex = text.slice(i + 1, close);
    if (tex.trim()) out.push({ from: i, to: close + 1, tex });
    i = close + 1;
  }
  return out;
}

/** Replace inline-math spans with spaces (length-preserving) so downstream scanners
 *  (citations, cross-refs) can't see inside math — the masking twin of the renderer
 *  extracting those spans before its transforms. */
export function maskInlineMath(text: string): string {
  const spans = findInlineMath(text);
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.from) + " ".repeat(s.to - s.from);
    at = s.to;
  }
  return out + text.slice(at);
}

export const EQ_LABEL_TAIL = /\{#(eq-[A-Za-z0-9_-]+)\}\s*$/;
/** A closing display line: ends `$$` optionally followed by ` {#eq-id}`. */
const CLOSES = (t: string): boolean => /\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/.test(t);

export interface MathBlock {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive (the closing/label line)
  tex: string; // joined content between the $$ fences
  label?: string; // eq-… when the closing line carries {#eq-id}
}

/** Line-feeding tracker for `$$` display blocks — feed every document line IN ORDER
 *  (the caller owns fence/front-matter skipping); finished blocks are returned as
 *  they close. Unterminated math at EOF yields no block (never eat the document). */
export class MathBlockTracker {
  private open = false;
  private start = 0;
  private buf: string[] = [];

  get inMath(): boolean {
    return this.open;
  }

  /** Feed line `lineNo` (1-based). Returns a completed block when this line closes one. */
  feed(lineNo: number, raw: string): MathBlock | null {
    const t = raw.trim();
    if (this.open) {
      if (CLOSES(t)) {
        this.open = false;
        // Content on the closing line before the $$ (rare, allowed): "x + y $$".
        const before = t.replace(/\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/, "").trim();
        if (before) this.buf.push(before);
        const label = EQ_LABEL_TAIL.exec(t)?.[1];
        const block: MathBlock = { startLine: this.start, endLine: lineNo, tex: this.buf.join("\n"), label };
        this.buf = [];
        return block;
      }
      this.buf.push(raw);
      return null;
    }
    if (!t.startsWith("$$")) return null;
    const rest = t.slice(2);
    if (rest.includes("$$")) {
      // Single-line $$…$$ [{#eq-id}]
      const label = EQ_LABEL_TAIL.exec(t)?.[1];
      const tex = rest.replace(/\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/, "").trim();
      return { startLine: lineNo, endLine: lineNo, tex, label };
    }
    this.open = true;
    this.start = lineNo;
    this.buf = rest.trim() ? [rest.trim()] : [];
    return null;
  }
}
