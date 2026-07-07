// ONE appearance-order numbering rule for inline-defined cross-referenceables —
// labeled tables today, labeled display equations when math lands (2.1). Consumed
// by BOTH the editor decorations (science/tables.ts keeps its registry aligned)
// and the renderer/export (render/renderManuscript.ts resolves @tbl/@eq from a
// pre-scan of the SAME text it renders) so one document can never number
// differently in the two — the old editor counted EVERY pipe table while the
// export counted captioned ones, making a single export self-contradictory.
//
// Semantics (Quarto's): only LABELED constructs participate in numbering.
//   table:    a `: Caption {#tbl-id}` line attached to a pipe table (directly
//             below it, or after one blank line — the editor's adjacency rule);
//             a stray caption line numbers nothing.
//   equation: a display block `$$ … $$` whose CLOSING line ends `{#eq-id}`
//             (single-line `$$…$$ {#eq-id}` too).
// Fenced code (``` / ~~~) is skipped. Pure text-in maps-out — no CodeMirror, no
// DOM — so it runs identically in the editor, the renderer, and tests.

export const TBL_CAPTION_RE = /^\s*:\s+(.*?)\s*\{#(tbl-[A-Za-z0-9_-]+)\}\s*$/;
export const EQ_LABEL_RE = /\{#(eq-[A-Za-z0-9_-]+)\}\s*$/;

export interface RefNumbers {
  tbl: Map<string, number>;
  eq: Map<string, number>;
}

const FENCE_RE = /^(```|~~~)/;
const isPipeRow = (s: string): boolean => s.includes("|") && s.trim() !== "";

export function scanRefNumbers(text: string): RefNumbers {
  const tbl = new Map<string, number>();
  const eq = new Map<string, number>();
  let tblN = 0;
  let eqN = 0;
  let inFence = false;
  let inMath = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!inMath && FENCE_RE.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Display math: `$$` opens; the line whose END is `$$` (± a {#eq-id}) closes.
    if (inMath) {
      if (/\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/.test(t)) {
        inMath = false;
        const label = EQ_LABEL_RE.exec(t)?.[1];
        if (label && !eq.has(label)) eq.set(label, ++eqN);
      }
      continue;
    }
    if (t.startsWith("$$")) {
      const rest = t.slice(2);
      if (/\$\$\s*(\{#eq-[A-Za-z0-9_-]+\}\s*)?$/.test(rest) && rest.includes("$$")) {
        // single-line $$…$$ [{#eq-id}]
        const label = EQ_LABEL_RE.exec(t)?.[1];
        if (label && !eq.has(label)) eq.set(label, ++eqN);
      } else {
        inMath = true;
      }
      continue;
    }

    const m = TBL_CAPTION_RE.exec(raw);
    if (m) {
      // Attached to a table? The previous non-blank line must be a pipe row
      // (mirrors science/tables.ts parseAt: caption directly below or after
      // exactly one blank line).
      let j = i - 1;
      if (j >= 0 && lines[j].trim() === "") j--;
      if (j >= 0 && isPipeRow(lines[j]) && !tbl.has(m[2])) tbl.set(m[2], ++tblN);
    }
  }
  return { tbl, eq };
}
