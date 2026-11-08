// Pack "placeholders": the leftovers nobody means to send.
//
//   placeholder.marker        warn  TODO / FIXME / XXX / TBD, [??], ??, [citation needed],
//                                   [cite] / [ref], "n = XX", lorem ipsum, {{< placeholder >}}
//   placeholder.comment-note  info  a TODO / FIXME inside an HTML comment (it never
//                                   prints, but it is a note left behind)
//
// Code, math and front matter are never read. The only fix offered is the one
// that cannot be wrong: a placeholder typed twice in a row ("[??] [??]") drops
// the repeat.

import type { CheckContext } from "./context";
import type { CheckFinding } from "./types";

type Add = (f: Omit<CheckFinding, "pack" | "doc" | "line" | "col">) => void;

const MARKERS: { re: RegExp; what: string }[] = [
  { re: /\b(?:TODO|FIXME|TBD)\b:?/g, what: "a to-do marker" },
  { re: /\bXXX+\b/g, what: "a to-do marker" },
  { re: /\[\s*\?+\s*\]/g, what: "an unresolved reference marker" },
  { re: /(?<![\w?!.])\?{2,}(?![\w?])/g, what: "an unresolved reference marker" },
  { re: /\[(?:citation needed|citations? needed|cite|cit|ref|refs|reference needed|source)\]/gi, what: "a missing-citation marker" },
  { re: /[=<>≤≥]\s*XX+\b/g, what: "a number placeholder" },
  { re: /\blorem ipsum\b/gi, what: "filler text" },
  { re: /\{\{<\s*placeholder\b[^}]*>\}\}/g, what: "a placeholder shortcode" },
];

/** Fenced-code and front-matter spans only — HTML comments stay readable. */
function fenceSpans(text: string, bodyStart: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (bodyStart > 0) out.push({ from: 0, to: bodyStart });
  let open = -1, fence = "";
  let pos = bodyStart;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(pos, Math.min(nl, pos + 40)));
    if (m) {
      if (open < 0) {
        open = pos;
        fence = m[1];
      } else if (m[1][0] === fence[0] && m[1].length >= fence.length) {
        out.push({ from: open, to: nl });
        open = -1;
      }
    }
    pos = nl + 1;
  }
  if (open >= 0) out.push({ from: open, to: text.length });
  return out;
}

export function placeholdersPack(ctx: CheckContext, add: Add): void {
  const { prose, text } = ctx;
  const hits: { from: number; to: number; what: string }[] = [];
  for (const { re, what } of MARKERS) {
    re.lastIndex = 0;
    for (const m of prose.matchAll(re)) {
      const from = m.index!, to = from + m[0].length;
      if (hits.some((h) => from < h.to && to > h.from)) continue;
      hits.push({ from, to, what });
    }
  }
  hits.sort((a, b) => a.from - b.from);
  let prev: { from: number; to: number } | null = null;
  for (const h of hits) {
    const excerpt = text.slice(h.from, h.to);
    // The same marker twice in a row, whitespace between: the repeat goes.
    const repeat =
      prev && text.slice(prev.from, prev.to) === excerpt && /^[ \t]+$/.test(text.slice(prev.to, h.from));
    add({
      ruleId: "placeholder.marker",
      severity: "warn",
      message: repeat
        ? `"${excerpt}" is repeated; the placeholder is still open.`
        : `"${excerpt}" is ${h.what} still in the text.`,
      from: h.from,
      to: h.to,
      excerpt,
      ...(repeat
        ? { fix: { label: "Remove the repeat", edits: [{ from: prev!.to, to: h.to, insert: "", expect: text.slice(prev!.to, h.to) }] } }
        : {}),
    });
    prev = h;
  }

  // HTML comments carrying a to-do (outside code and front matter).
  if (!text.includes("<!--")) return;
  const fences = fenceSpans(text, ctx.bodyStart);
  const inFence = (i: number) => fences.some((s) => i >= s.from && i < s.to);
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (inFence(m.index!)) continue;
    const note = /\b(TODO|FIXME|XXX+|TBD)\b/.exec(m[1]);
    if (!note) continue;
    add({
      ruleId: "placeholder.comment-note",
      severity: "info",
      message: `A hidden ${note[1]} note is still in the document (comments never print).`,
      from: m.index!,
      to: m.index! + m[0].length,
      excerpt: m[0].length > 60 ? m[0].slice(0, 57) + "…" : m[0],
    });
  }
}
