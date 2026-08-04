// Shared embed-line grammar + the bare-Quarto export transform (pure text).
//
// EMBED_RE is THE grammar for manuscript figure-embed lines
// (`![alt](../fig/renders/<id>.svg){#fig-<id> attrs}`); the paper editor's
// science/figureAttrs.ts re-exports it from here. It lives in src/lib so
// headless flux-core shares it without pulling editor modules.
//
// transformQmdForExport prepares manuscript text for a render Flux does NOT
// control (quarto → pdf/html/docx). Since figure families landed, Quarto's
// own appearance-order figure numbering can't express Flux numbering at all
// (supplementary/extended-data/custom families each count independently), so
// the transform stops delegating ANY figure numbering to Quarto:
//   1. Quarto uses the image ALT text as the figcaption. Flux's caption
//      source of truth is the figure model, and canonical embeds carry an
//      EMPTY alt — inject the family caption lead ("Figure S4 | ") + composed
//      caption into empty alts, escaped for the alt slot.
//   2. Embed crossref ids are DEMOTED (`{#fig-x}` → `{#x-fig-x}`) so Quarto
//      neither numbers the figure nor prefixes its own "Figure N:" label —
//      the injected family lead is the only label. The anchor survives for
//      HTML linking, under the demoted id.
//   3. ALL `@fig-…` refs (whole-figure and panel) become literal family-
//      formatted text ("Fig. S4", "Fig. 3a–c"). Unknown labels pass through
//      for Quarto to complain about. Labels themselves may contain hyphens,
//      so `-a` is a panel spec only when the head is a known label.
// Deliberate trade-offs (documented in the engineering guide): exported-HTML
// anchors change form, and Quarto lists-of-figures lose their entries.

import { formatCaptionLabel, formatFamilyRef, type FigureFamilyDef } from "./figfamily";

export const EMBED_RE =
  /^\s*!\[((?:\\.|[^\]])*)\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)([^}]*)\}\s*$/;

/** Quarto `{{< include path >}}` — path is relative to the INCLUDING file.
 *  THE grammar for the include tree; both engines read it from here. */
export const INCLUDE_RE = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g;

/** Resolve an include target against the including file's directory, pure and
 *  separator-aware (win32 backslash paths keep their separator). `.`/`..` are
 *  folded so the result is a real path rather than one the OS has to
 *  normalize — the renderer's file bridge does no normalization of its own. */
export function resolveInclude(includingFile: string, rel: string): string {
  const win = includingFile.includes("\\") && !includingFile.includes("/");
  const sep = win ? "\\" : "/";
  const parts = includingFile.split(/[\\/]/);
  parts.pop(); // drop the filename → the including directory
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    // Never pop past the root (or a "C:" drive prefix): a runaway `..` chain
    // would otherwise silently escape into a nonsense path.
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join(sep);
}

/** IO injected into `readQmdTree` — the twin-engine seam. flux-core supplies
 *  node:fs + node:path; the renderer supplies its file bridge. */
export interface QmdTreeIO {
  /** Read a file; resolve to null when it can't be read (missing include). */
  readText(abs: string): Promise<string | null>;
  /** Defaults to `resolveInclude`; flux-core injects node:path.resolve. */
  resolveFrom?: (includingFile: string, rel: string) => string;
}

export interface QmdTree {
  /** Involved files in traversal order, entry first, de-duplicated. */
  files: string[];
  /** Every file's text, keyed by the absolute path used to read it. */
  texts: Map<string, string>;
  /** Includes spliced in place — the single document Quarto actually sees. */
  expanded: string;
}

/**
 * Read a .qmd and its transitive `{{< include >}}` tree. ONE walker for both
 * engines — the GUI and flux-core each had their own, with their own copy of
 * INCLUDE_RE and subtly different path joining.
 *
 * `seen` is shared across calls on purpose: walking several entry documents
 * (main + supplementary) must visit each file once, so a file already spliced
 * into an earlier document contributes no second copy.
 */
export async function readQmdTree(
  entry: string,
  io: QmdTreeIO,
  seen = new Set<string>(),
  texts = new Map<string, string>(),
): Promise<QmdTree> {
  if (seen.has(entry)) return { files: [], texts, expanded: "" };
  seen.add(entry);
  const resolveFrom = io.resolveFrom ?? resolveInclude;
  const text = (await io.readText(entry)) ?? "";
  texts.set(entry, text);
  const files = [entry];
  let expanded = "";
  let last = 0;
  for (const m of text.matchAll(INCLUDE_RE)) {
    expanded += text.slice(last, m.index);
    const sub = await readQmdTree(resolveFrom(entry, m[1]), io, seen, texts);
    files.push(...sub.files);
    expanded += sub.expanded;
    last = (m.index ?? 0) + m[0].length;
  }
  return { files, texts, expanded: expanded + text.slice(last) };
}

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

/** Embed labels in order of appearance — Quarto numbers figures the same way,
 *  so `collectEmbedLabels(expandedDoc)[i]` is "Figure i+1" in the output. */
export function collectEmbedLabels(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = EMBED_RE.exec(line);
    if (m && !out.includes(m[3])) out.push(m[3]);
  }
  return out;
}

/** Clear the alt of every embed whose label resolves — the canonical embed
 *  carries an EMPTY alt (the figure model owns captions; Quarto exports get
 *  them injected at render time). Unresolvable embeds keep their alt: it is
 *  their only caption fallback. Pure; drives the `normalize-embeds` verb and
 *  the paper editor's on-load normalization. */
export function normalizeEmbedAlts(
  text: string,
  resolvable: (label: string) => boolean,
): { text: string; cleared: number } {
  let cleared = 0;
  const lines = text.split("\n").map((line) => {
    const m = EMBED_RE.exec(line);
    if (!m || m[1].length === 0 || !resolvable(m[3])) return line;
    cleared++;
    const ws = /^\s*/.exec(line)![0];
    return `${ws}![](${m[2]}){#${m[3]}${m[4]}}`;
  });
  return { text: lines.join("\n"), cleared };
}

export interface ExportQmdCtx {
  /** label (e.g. "fig-growth") → composed caption markdown (no label lead —
   *  the family caption template supplies it). */
  captions: Map<string, string>;
  /** label → resolved family identity — THE editor's numbers (figfamily.ts),
   *  never re-derived from embed appearance order. */
  figures: Map<string, { family: FigureFamilyDef; number: number }>;
}

// One panel spec: `a`, a range `a-c`, comma lists of either (`a,b`, `a-c,e`).
// Mirrors scholar/figText.panelSpec's output grammar.
const PANEL_SPEC_RE = /^[A-Za-z](?:-[A-Za-z])?(?:,[A-Za-z](?:-[A-Za-z])?)*$/;
// A whole crossref token incl. comma-continued panel parts (grammar.ts crossrefRe).
const FIG_REF_RE = /@(fig-[A-Za-z0-9_-]+(?:,[A-Za-z](?:-[A-Za-z])?)*)/g;

/** `a-c,e` → `a–c,e` (ranges display with an en-dash, mirroring the app). */
export function panelSpecDisplay(spec: string): string {
  return spec.replace(/-/g, "–");
}

export function transformQmdForExport(text: string, ctx: ExportQmdCtx): string {
  // 1) Embed lines: family caption lead + composed caption into EMPTY alts,
  //    and the crossref id demoted so Quarto adds no label of its own.
  const withCaptions = text
    .split("\n")
    .map((line) => {
      const m = EMBED_RE.exec(line);
      if (!m) return line;
      const fig = ctx.figures.get(m[3]);
      if (!fig) return line; // unknown label — leave the line for Quarto
      const ws = /^\s*/.exec(line)![0];
      let alt = m[1];
      if (alt.trim() === "") {
        const lead = formatCaptionLabel(fig.family, fig.number);
        const cap = ctx.captions.get(m[3])?.trim() ?? "";
        alt = escapeEmbedCaption(`**${lead.trim()}** ${cap}`.trim());
      }
      return `${ws}![${alt}](${m[2]}){#x-${m[3]}${m[4]}}`;
    })
    .join("\n");

  // 2) ALL fig refs → literal family-formatted text ("Fig. S4", "Fig. 3a–c");
  //    unknown labels pass through for Quarto to resolve/complain about.
  const labels = [...ctx.figures.keys()].sort((a, b) => b.length - a.length);
  return withCaptions.replace(FIG_REF_RE, (whole, token: string) => {
    const exact = ctx.figures.get(token);
    if (exact) return formatFamilyRef(exact.family, exact.number);
    for (const label of labels) {
      if (!token.startsWith(label + "-")) continue;
      const spec = token.slice(label.length + 1);
      if (PANEL_SPEC_RE.test(spec)) {
        const fig = ctx.figures.get(label)!;
        return formatFamilyRef(fig.family, fig.number, panelSpecDisplay(spec));
      }
    }
    return whole;
  });
}
