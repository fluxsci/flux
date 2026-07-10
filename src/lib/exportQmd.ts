// Shared embed-line grammar + the bare-Quarto export transform (pure text).
//
// EMBED_RE is THE grammar for manuscript figure-embed lines
// (`![alt](../fig/renders/<id>.svg){#fig-<id> attrs}`); the paper editor's
// science/figureAttrs.ts re-exports it from here. It lives in src/lib so
// headless flux-core shares it without pulling editor modules.
//
// transformQmdForExport prepares manuscript text for a render Flux does NOT
// control (quarto → pdf/html/docx):
//   1. Quarto uses the image ALT text as the figcaption (and only captioned
//      figures get crossref numbers). Flux's caption source of truth is the
//      figure model, and canonical embeds carry an EMPTY alt — inject the
//      composed caption into empty alts, escaped for the alt slot.
//   2. Quarto's crossref only knows whole figures: `@fig-x-a` compiles to a
//      literal "?@fig-x-a". Panel refs become literal text ("Figure 3a",
//      "Figure 3a–c") numbered by order of appearance — exactly Quarto's own
//      figure numbering — using the project's real labels for the split
//      (labels themselves may contain hyphens, so `-a` is a panel spec only
//      when the head is a known label).

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
  /** label (e.g. "fig-growth") → composed caption markdown (no "Figure N." lead —
   *  Quarto prefixes its own). */
  captions: Map<string, string>;
  /** label → figure number by order of appearance in the EXPANDED document. */
  numbers: Map<string, number>;
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
  // 1) Composed captions into EMPTY embed alts.
  const withCaptions = text
    .split("\n")
    .map((line) => {
      const m = EMBED_RE.exec(line);
      if (!m || m[1].trim() !== "") return line;
      const cap = ctx.captions.get(m[3]);
      if (!cap?.trim()) return line;
      const ws = /^\s*/.exec(line)![0];
      return `${ws}![${escapeEmbedCaption(cap)}](${m[2]}){#${m[3]}${m[4]}}`;
    })
    .join("\n");

  // 2) Panel refs → literal "Figure <n><spec>" text (whole-figure refs and
  //    unknown labels pass through for Quarto to resolve/complain about).
  const labels = [...ctx.numbers.keys()].sort((a, b) => b.length - a.length);
  return withCaptions.replace(FIG_REF_RE, (whole, token: string) => {
    if (ctx.numbers.has(token)) return whole; // plain @fig-x — Quarto's job
    for (const label of labels) {
      if (!token.startsWith(label + "-")) continue;
      const spec = token.slice(label.length + 1);
      if (PANEL_SPEC_RE.test(spec)) return `Figure ${ctx.numbers.get(label)}${panelSpecDisplay(spec)}`;
    }
    return whole;
  });
}
