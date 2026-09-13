/** Portable, document-owned slide references. No editor, filesystem or store dependencies. */
import { escapeEmbedCaption, unescapeEmbedCaption } from "../exportQmd";
import { relativeDocumentPath } from "../project/documentFiles";

export interface SlideEmbedRef { id: string; deck: string; slide: string; path: string; caption: string; width: string | null; extra: string[] }
export interface SlideEmbedSpan { from: number; to: number; ref: SlideEmbedRef }
export const embedKey = (r: Pick<SlideEmbedRef, "deck" | "slide">) => JSON.stringify([r.deck, r.slide]);
export const validEmbedId = (id: string) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id);
export function posterPath(deck: string, slide: string): string {
  if (!validEmbedId(deck) || !validEmbedId(slide)) throw new Error("Invalid deck or slide ID");
  return `slides/${deck}/renders/${slide}-step-0.svg`;
}
export const validEmbedWidth = (s: string) => /^(?:\d+(?:\.\d+)?)(?:%|px|in|cm|mm|pt)?$/.test(s) && parseFloat(s) > 0;
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function parseSlideEmbed(line: string): SlideEmbedRef | null {
  const m = /^\s*!\[((?:\\.|[^\]])*)\]\(([^)]*)\)\{([^}]*)\}\s*$/.exec(line);
  if (!m) return null;
  const tokens: string[] = m[3].match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g) ?? [];
  if (!tokens.includes(".flux-slide")) return null;
  const fields: Record<string, string> = {};
  let id = ""; const extra: string[] = [];
  for (const t of tokens) {
    if (t === ".flux-slide") continue;
    if (t.startsWith("#") && !id) { id = t.slice(1); continue; }
    const attr = /^(deck|slide|width)=(.*)$/.exec(t);
    if (attr && !(attr[1] in fields)) fields[attr[1]] = attr[2].replace(/^(["'])(.*)\1$/, "$2").replace(/\\([\\"'])/g, "$1");
    else extra.push(t);
  }
  return { id, deck: fields.deck ?? "", slide: fields.slide ?? "", path: m[2], caption: unescapeEmbedCaption(m[1]), width: fields.width && validEmbedWidth(fields.width) ? fields.width : null, extra };
}
export function serializeSlideEmbed(r: SlideEmbedRef): string {
  return `![${escapeEmbedCaption(r.caption)}](${r.path}){${r.id ? `#${r.id} ` : ""}.flux-slide deck=${quote(r.deck)} slide=${quote(r.slide)}${r.width ? ` width=${r.width}` : ""}${r.extra.length ? ` ${r.extra.join(" ")}` : ""}}`;
}
export function newSlideEmbed(doc: string, deck: string, slide: string, opts: { id?: string; width?: string | null; caption?: string } = {}): SlideEmbedRef {
  const width = opts.width === undefined ? "100%" : opts.width;
  if (width && !validEmbedWidth(width)) throw new Error("Invalid slide width");
  return { id: opts.id ?? `slide-${crypto.randomUUID()}`, deck, slide, path: relativeDocumentPath(doc, posterPath(deck, slide)), caption: opts.caption ?? "", width, extra: [] };
}
/** Standalone image blocks only. Exclude YAML, fences, comments and display math. */
export function scanSlideEmbeds(text: string): SlideEmbedSpan[] {
  const out: SlideEmbedSpan[] = [];
  let fence = "", fenceCount = 0, yaml = false, comment = false, math = "";
  for (const m of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!m[0]) continue;
    const raw = m[0].replace(/\r?\n$/, ""), trimmed = raw.trim();
    if (m.index === 0 && trimmed === "---") { yaml = true; continue; }
    if (yaml) { if (/^(---|\.\.\.)$/.test(trimmed)) yaml = false; continue; }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) { if (!fence) { fence = f[1][0]; fenceCount = f[1].length; } else if (f[1][0] === fence && f[1].length >= fenceCount && !raw.slice(f[0].length).trim()) fence = ""; continue; }
    if (fence || /^ {4}|^\t/.test(raw)) continue;
    if (comment || raw.includes("<!--")) { comment = raw.lastIndexOf("<!--") > raw.lastIndexOf("-->") || comment && !raw.includes("-->"); continue; }
    if (math) { if (trimmed.includes(math)) math = ""; continue; }
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) { const end = trimmed.startsWith("$$") ? "$$" : "\\]"; if (!trimmed.slice(2).includes(end)) math = end; continue; }
    const ref = parseSlideEmbed(raw);
    if (ref) out.push({ from: m.index!, to: m.index! + raw.length, ref });
  }
  return out;
}
export function planSlideInsertion(text: string, pos: number, markdown: string): { from: number; to: number; insert: string; anchor: number } {
  const start = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const endAt = text.indexOf("\n", pos), end = endAt < 0 ? text.length : endAt;
  const empty = !text.slice(start, end).trim();
  const from = empty ? start : end, insert = (empty ? "" : "\n\n") + markdown;
  return { from, to: end, insert, anchor: from + insert.length };
}
