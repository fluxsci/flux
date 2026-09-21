import { findInlineMath } from "./mathGrammar";
/** Source-preserving protected spans shared by export preparation and widgets. */
export interface SourceSpan { from: number; to: number }
export function protectedDocumentSpans(text: string, opts: { math?: boolean; inline?: boolean } = {}): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let fence = "", count = 0, yaml = false, comment = false, math = "";
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const from = match.index!, to = from + match[0].length, raw = match[0].replace(/\r?\n$/, ""), trim = raw.trim();
    const add = () => spans.push({ from, to });
    if (from === 0 && trim === "---") { yaml = true; add(); continue; }
    if (yaml) { add(); if (/^(---|\.\.\.)$/.test(trim)) yaml = false; continue; }
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (mark && !math) {
      if (!fence) { fence = mark[1][0]; count = mark[1].length; }
      else if (mark[1][0] === fence && mark[1].length >= count && !raw.slice(mark[0].length).trim()) fence = "";
      add(); continue;
    }
    if (fence || /^(?: {4}|\t)/.test(raw)) { add(); continue; }
    if (comment || raw.includes("<!--")) { comment = raw.lastIndexOf("<!--") > raw.lastIndexOf("-->") || comment && !raw.includes("-->"); add(); continue; }
    if (opts.math !== false) {
      if (math) { if (trim.includes(math)) math = ""; add(); continue; }
      if (trim.startsWith("$$") || trim.startsWith("\\[")) { const end = trim.startsWith("$$") ? "$$" : "\\]"; if (!trim.slice(2).includes(end)) math = end; add(); continue; }
    }
    if (opts.inline !== false) {
      const inline: SourceSpan[] = [];
      for (let i = 0; i < raw.length;) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i] !== "`") { i++; continue; }
        let end = i + 1; while (raw[end] === "`") end++;
        const run = raw.slice(i, end); let close = raw.indexOf(run, end);
        while (close >= 0 && (raw[close - 1] === "`" || raw[close + run.length] === "`")) close = raw.indexOf(run, close + run.length);
        if (close < 0) { i = end; continue; }
        inline.push({ from: i, to: close + run.length }); i = close + run.length;
      }
      if (opts.math !== false) for (const span of findInlineMath(raw)) if (!inline.some(code => span.from < code.to && span.to > code.from)) inline.push(span);
      inline.sort((a,b) => a.from-b.from);
      for (const span of inline) spans.push({from: from+span.from,to: from+span.to});
    }
  }
  return spans;
}
export function mapUnprotected(text: string, transform: (text: string) => string, opts?: { math?: boolean; inline?: boolean }): string {
  const spans = protectedDocumentSpans(text, opts);
  let result = "", pos = 0;
  for (const span of spans) { if (span.from < pos) continue; result += transform(text.slice(pos, span.from)) + text.slice(span.from, span.to); pos = span.to; }
  return result + transform(text.slice(pos));
}
