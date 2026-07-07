// The single grammar + attribute model for figure embed lines (PAP-19 spirit:
// one source of truth). An embed line is canonical Quarto:
//   `![Caption](../fig/renders/<id>.svg){#fig-<id> width=60% …}`
// The width attr is the ONLY interpreted attribute — everything else round-trips
// verbatim (fig-align, classes, … must survive edits untouched so the .qmd
// stays portable). Consumed by the live embeds (science/embeds.ts), the
// renderer/export (render/renderManuscript.ts) and the resize commands
// (editing/figureSize.ts).

import type { EditorState, Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// Caption group: escaped-anything or non-`]` — a literal `]` can appear only as
// `\]`, so the `](` boundary is unambiguous and a caption containing "](…)" (a
// markdown link, "…[subset](note)…") can no longer split the line and silently
// degrade the embed to prose.
export const EMBED_RE =
  /^\s*!\[((?:\\.|[^\]])*)\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)([^}]*)\}\s*$/;

/** Escape a caption for the `![…]` alt-text slot (backslash + square brackets);
 *  newlines collapse — an embed line is one line by construction. markdown-it
 *  unescapes these natively on render, so exports show the original text. */
export function escapeEmbedCaption(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** Inverse of escapeEmbedCaption — for editor-side display of the raw group. */
export function unescapeEmbedCaption(s: string): string {
  return s.replace(/\\([\\[\]])/g, "$1");
}

export interface EmbedAttrs {
  /** Verbatim `width=` value ("60%", "320", "3in") or null when unset. */
  width: string | null;
  /** Every other attribute token, verbatim, space-joined ("" when none). */
  rest: string;
}

/** Split an attr tail (regex group 4) on whitespace, respecting quoted values. */
function tokenize(raw: string): string[] {
  return raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

export function parseEmbedAttrs(raw: string): EmbedAttrs {
  let width: string | null = null;
  const rest: string[] = [];
  for (const tok of tokenize(raw)) {
    if (width === null && tok.startsWith("width=")) {
      width = tok.slice("width=".length).replace(/^"|"$/g, "") || null;
    } else {
      rest.push(tok);
    }
  }
  return { width, rest: rest.join(" ") };
}

/** `{#fig-x width=60% rest…}` — width always right after the id. */
export function serializeAttrBlock(id: string, a: EmbedAttrs): string {
  const parts = [`#${id}`];
  if (a.width) parts.push(`width=${a.width}`);
  if (a.rest) parts.push(a.rest);
  return `{${parts.join(" ")}}`;
}

/** "60%" → 0.6 (clamped to (0,1]); non-percent widths → null. */
export function widthFraction(width: string | null): number | null {
  if (!width) return null;
  const m = /^(\d+(?:\.\d+)?)%$/.exec(width);
  if (!m) return null;
  const f = parseFloat(m[1]) / 100;
  return f > 0 ? Math.min(1, f) : null;
}

/** A width value → CSS length ("60%" verbatim, bare number → px, units pass through). */
export function cssWidth(width: string): string {
  return /^\d+(?:\.\d+)?$/.test(width) ? `${width}px` : width;
}

export interface EmbedLineInfo {
  line: Line;
  caption: string;
  path: string;
  id: string;
  attrs: EmbedAttrs;
}

/** Parse the embed line containing `pos`, or null if that line isn't an embed. */
export function embedLineAt(state: EditorState, pos: number): EmbedLineInfo | null {
  const line = state.doc.lineAt(Math.min(pos, state.doc.length));
  const m = EMBED_RE.exec(line.text);
  if (!m) return null;
  return { line, caption: m[1], path: m[2], id: m[3], attrs: parseEmbedAttrs(m[4]) };
}

/**
 * Set (or clear, width=null) the width attr of the embed line containing
 * `pos`, rewriting ONLY the `{…}` span. Returns false if `pos` isn't on an
 * embed line.
 */
export function setEmbedWidth(
  view: EditorView,
  pos: number,
  width: string | null,
): boolean {
  const info = embedLineAt(view.state, pos);
  if (!info) return false;
  const open = info.line.text.lastIndexOf("{#");
  const close = info.line.text.lastIndexOf("}");
  if (open < 0 || close < open) return false;
  view.dispatch({
    changes: {
      from: info.line.from + open,
      to: info.line.from + close + 1,
      insert: serializeAttrBlock(info.id, { ...info.attrs, width }),
    },
    userEvent: "input.figwidth",
  });
  return true;
}
