// Journal export assets: what a style needs on disk, and the Quarto profile
// that points at it. PURE — it plans, it does not write. Each engine performs
// the IO (flux-core with node:fs, the Electron main process for the GUI path)
// and both produce byte-identical profiles, which verify-journal-assets pins.
//
// WHY A PROFILE, not front-matter rewriting: Quarto merges
// `_quarto-<profile>.yml` over the project's own `_quarto.yml` when rendered
// with `--profile <name>`. That means Flux never edits the user's Quarto config
// or their YAML front matter to style an export — it drops one ephemeral file,
// renders, and deletes it. The user's sources stay theirs.

import type { ResolvedJournalStyle } from "./journalStyle";

/** The generated profile's name and filename. One per project at a time; it is
 *  written before the render and deleted in the same `finally` as the source
 *  restore, so a crashed export leaves at most one stale file that the next
 *  export overwrites. */
export const EXPORT_PROFILE = "flux-export";
export const EXPORT_PROFILE_FILE = `_quarto-${EXPORT_PROFILE}.yml`;

export interface JournalAsset {
  /** Where it lands, relative to the PROJECT root. */
  rel: string;
  /** Which shipped resource provides it, relative to the repo's resources/. */
  resource: string;
}

/**
 * Durable assets a style needs in the project. They live in the directories the
 * project scaffold has always created for exactly this purpose
 * (`references/styles/`, `styles/journal/`), so they are user-inspectable and
 * commit-friendly rather than hidden in a cache.
 */
export function journalAssetPlan(style: ResolvedJournalStyle): JournalAsset[] {
  const out: JournalAsset[] = [];
  // `assetKey` (not the style id) names the SHIPPED files: a style that extends
  // another reuses its parent's CSL and Word template rather than asking for
  // files that do not exist.
  const key = style.assetKey || style.id;
  if (style.csl) out.push({ rel: style.csl, resource: `csl/${key}.csl` });
  if (style.document.lineNumbers || style.document.fontFamily || style.document.lineSpacing) {
    out.push({
      rel: `styles/journal/${key}/reference.docx`,
      resource: `docx/${key}-reference.docx`,
    });
  }
  // The PDF path typesets the assembler's custom-style blocks with one Lua filter.
  if (style.manuscript) out.push({ rel: JOURNAL_LUA_REL, resource: "lua/flux-journal.lua" });
  return out;
}

/** Where the journal Lua filter lands in the project (shared by every venue). */
export const JOURNAL_LUA_REL = "styles/journal/flux-journal.lua";

/**
 * Turn a Quarto failure log into one actionable sentence, or null when we have
 * nothing better to say than the log itself.
 *
 * The LaTeX path fails in ways whose logs are genuinely unreadable — a missing
 * `rsvg-convert` surfaces as a Lua stack trace ten frames deep, and a missing
 * LaTeX package as a TeX error buried in a rerun. Both are one apt/tlmgr
 * command away, so saying which one beats printing the trace.
 */
export function diagnoseQuartoFailure(log: string): string | null {
  // No quarto at all: spawn failed before Quarto could print anything.
  if (/spawn \S*quarto(\.exe)? ENOENT/i.test(log)) {
    return "Quarto is not installed. In Flux open Settings → Set up Flux… → Install Quarto (no admin rights needed), or install it from quarto.org.";
  }
  if (/rsvg[-_ ]?convert/i.test(log)) {
    return (
      "Quarto needs `rsvg-convert` to place SVG figures in a PDF. " +
      "Install it: librsvg2-bin (Debian/Ubuntu), librsvg (Homebrew/Arch)."
    );
  }
  const missingSty = /(?:! )?LaTeX Error: File `([\w.-]+)\.sty' not found/.exec(log);
  if (missingSty) {
    const pkg = missingSty[1];
    return (
      `The LaTeX package \`${pkg}\` is missing. ` +
      `Install it with \`tlmgr install ${pkg}\` (TinyTeX/MacTeX) or your distro's TeX Live packages ` +
      "(lineno → texlive-humanities, setspace → texlive-latex-recommended on Debian/Ubuntu)."
    );
  }
  // lualatex is present but its OpenType loader is not — the usual shape of a
  // minimal distro TeX install, and unrecognisable from the raw log.
  if (/luaotfload/i.test(log)) {
    return (
      "lualatex is missing its font loader (luaotfload). " +
      "Install texlive-luatex (Debian/Ubuntu), or use TinyTeX: `quarto install tinytex`."
    );
  }
  // Times metrics absent: mathptmx/fontspec resolve but the fonts do not.
  if (/ptmr7t|not loadable: [Mm]etric|Font .* not loadable/i.test(log)) {
    return (
      "The requested font is not installed. Install texlive-fonts-recommended " +
      "(Debian/Ubuntu) for the standard Times-compatible set, or `quarto install tinytex`."
    );
  }
  if (/pdf-engine.*not found|xelatex.*not found|lualatex.*not found/i.test(log)) {
    return "No LaTeX engine found. In Flux open Settings → Set up Flux… → Add PDF support, or run `quarto install tinytex`.";
  }
  return null;
}

/** YAML-quote a scalar. Keeps the generated profile valid for fonts with
 *  spaces ("Times New Roman") without pulling in a YAML writer. */
function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Fallback chains for fonts a machine may not have: the first installed wins.
 *  A missing "Times New Roman" must not fail the render (it is absent on most
 *  Linux boxes); TeX Gyre ships with every TeX distribution. */
const FONT_FALLBACKS: Record<string, string[]> = {
  "Times New Roman": ["Times New Roman", "TeX Gyre Termes", "Liberation Serif", "Nimbus Roman"],
  Arial: ["Arial", "Helvetica", "Liberation Sans", "TeX Gyre Heros", "Nimbus Sans"],
  Helvetica: ["Helvetica", "Arial", "Liberation Sans", "TeX Gyre Heros", "Nimbus Sans"],
};

function fontChain(font: string): string {
  const chain = FONT_FALLBACKS[font] ?? [font];
  // \IfFontExistsTF{A}{\setmainfont{A}}{ \IfFontExistsTF{B}{…}{} }
  return chain.reduceRight((inner, f) => `\\IfFontExistsTF{${f}}{\\setmainfont{${f}}}{${inner}}`, "");
}

/** The LaTeX preamble that gives the PDF the same page as the Word template. */
function latexPreamble(style: ResolvedJournalStyle): string[] {
  const d = style.document;
  const L: string[] = [];
  const ind = (line: string) => `        ${line}`;
  if (style.manuscript) {
    if (d.fontFamily) L.push("\\usepackage{fontspec}", fontChain(d.fontFamily));
    const titlePt = style.manuscript.titleBlock === "preprint" ? 18 : style.manuscript.titleBlock === "nature" ? 16 : 14;
    L.push(
      `\\providecommand{\\fluxtitlefont}{\\fontsize{${titlePt}}{${Math.round(titlePt * 1.25)}}\\selectfont\\bfseries}`,
      "\\providecommand{\\fluxnoindent}{\\setlength{\\parindent}{0pt}}",
      "\\providecommand{\\fluxbibliography}{\\setlength{\\parindent}{0pt}}",
      "\\providecommand{\\fluxfigure}{}",
      "\\providecommand{\\fluxlegend}{\\setlength{\\parindent}{0pt}}",
      // Section heads: unnumbered, body size, the venue's weight (Science:
      // bold / bold italic / italic). Plain \\@startsection — no titlesec, which
      // a minimal TeX install (and TinyTeX before first use) lacks.
      "\\makeatletter",
      "\\renewcommand\\section{\\@startsection{section}{1}{\\z@}{12pt plus 2pt}{4pt}{\\normalfont\\normalsize\\bfseries}}",
      `\\renewcommand\\subsection{\\@startsection{subsection}{2}{\\z@}{8pt plus 2pt}{2pt}{\\normalfont\\normalsize\\bfseries${style.manuscript.titleBlock === "science" ? "\\itshape" : ""}}}`,
      "\\renewcommand\\subsubsection{\\@startsection{subsubsection}{3}{\\z@}{6pt plus 2pt}{1pt}{\\normalfont\\normalsize\\itshape}}",
      "\\makeatother",
      "\\setcounter{secnumdepth}{0}",
      d.firstLineIndentIn
        ? `\\setlength{\\parindent}{${d.firstLineIndentIn}in}\\setlength{\\parskip}{0pt}`
        : "\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{6pt plus 2pt}",
    );
    if (d.headerText) {
      L.push(
        "\\usepackage{fancyhdr}",
        "\\pagestyle{fancy}\\fancyhf{}\\renewcommand{\\headrulewidth}{0pt}",
        `\\lhead{\\small ${d.headerText.replace(/[\\{}%#&$_^~]/g, "")}}`,
        d.pageNumbers ? "\\cfoot{\\thepage}" : "",
      );
    } else L.push(d.pageNumbers ? "\\pagestyle{plain}" : "\\pagestyle{empty}");
  }
  if (d.lineNumbers) {
    L.push("\\usepackage{lineno}", "\\linenumbers");
    if (d.lineNumberCountBy && d.lineNumberCountBy > 1) L.push(`\\modulolinenumbers[${d.lineNumberCountBy}]`);
  }
  if (d.lineSpacing && d.lineSpacing > 1) {
    L.push(
      "\\usepackage{setspace}",
      d.lineSpacing >= 2 ? "\\doublespacing" : d.lineSpacing >= 1.5 ? "\\onehalfspacing" : `\\setstretch{${d.lineSpacing}}`,
    );
  }
  return L.filter(Boolean).map((l) => ind(l.replace(/\\\\/g, "\\")));
}

/**
 * The render settings of a JOURNAL style, as front-matter keys for the prepared
 * export copy of the document. Front matter is the one place Quarto always
 * honours: a `--profile` file is read only from the Quarto PROJECT directory,
 * which is not the document's directory when the manuscript sits in a subfolder
 * (paper/MANUSCRIPT_MAIN/manuscript.qmd under paper/_quarto.yml) — there the
 * profile was silently ignored. Paths are relative to the DOCUMENT's directory.
 */
export function journalRenderMeta(style: ResolvedJournalStyle, opts: { docDir: string }): Record<string, unknown> {
  const depth = opts.docDir.split(/[\\/]/).filter(Boolean).length;
  const up = "../".repeat(depth);
  const d = style.document;
  const meta: Record<string, unknown> = { "number-sections": false };
  if (style.manuscript) {
    meta.filters = [`${up}${JOURNAL_LUA_REL}`];
    if (style.manuscript.titleBlock === "science") meta["flux-title-align"] = "center";
    const delim = style.manuscript.titleBlock === "nature" ? "|" : ".";
    meta.crossref = {
      "title-delim": delim,
      "eq-prefix": style.manuscript.titleBlock === "science" ? "Eq." : "Equation",
      "tbl-title": "Table",
      "fig-title": "Figure",
    };
    if (style.manuscript.citations === "citeproc" && style.csl) meta.csl = `${up}${style.csl}`;
  }
  const docxRef = journalAssetPlan(style).find((a) => a.rel.endsWith("reference.docx"));
  const format: Record<string, unknown> = {};
  if (docxRef) format.docx = { "reference-doc": `${up}${docxRef.rel}` };
  const header = latexPreamble(style).map((l) => l.trim()).join("\n");
  for (const key of ["pdf", "latex"] as const) {
    const f: Record<string, unknown> = {};
    if (key === "pdf") f["pdf-engine"] = "lualatex";
    f.documentclass = "article";
    if (d.paperSize) f.papersize = d.paperSize;
    if (d.marginsIn) {
      const m = d.marginsIn;
      f.geometry = [`top=${m.top}in`, `bottom=${m.bottom}in`, `left=${m.left}in`, `right=${m.right}in`];
    }
    f.colorlinks = false;
    if (d.fontSizePt) f.fontsize = `${d.fontSizePt}pt`;
    if (header) f["include-in-header"] = { text: header + "\n" };
    format[key] = f;
  }
  meta.format = format;
  return meta;
}

/**
 * The Quarto profile for a style. Paths are written relative to the QUARTO
 * PROJECT directory (the manuscript folder, which is where `_quarto.yml` lives)
 * — hence the `../` prefixes — while the asset plan above is project-root
 * relative. Getting those two frames confused is the easiest way to produce a
 * profile Quarto silently ignores.
 */
export function journalProfileYaml(
  style: ResolvedJournalStyle,
  opts: { manuscriptDir?: string } = {},
): string {
  // Depth of the manuscript dir below the project root, so "../" repeats right
  // for a nested layout (manuscript/, or manuscript/sub/).
  const depth = (opts.manuscriptDir ?? "manuscript").split("/").filter(Boolean).length;
  const up = "../".repeat(depth);
  const lines: string[] = [
    "# Generated by Flux for a journal-styled export — do not edit.",
    `# Style: ${style.name} (${style.id}). Written before the render, deleted after.`,
  ];
  // A journal that literalizes its citations (Nature, Science, Cell) must not
  // hand pandoc a CSL: there is nothing left for citeproc to do.
  // A JOURNAL style (one with a manuscript spec) carries its render settings in
  // the prepared document's front matter instead (journalRenderMeta) — a profile
  // is ignored for a document below the Quarto project directory.
  if (style.manuscript) return lines.join("\n") + "\n";
  if (style.csl) lines.push(`csl: ${up}${style.csl}`);

  const d = style.document;
  const docxRef = journalAssetPlan(style).find((a) => a.rel.endsWith("reference.docx"));
  const fmt: string[] = [];
  if (docxRef) {
    fmt.push("  docx:", `    reference-doc: ${up}${docxRef.rel}`);
  }

  // A YAML literal block's CONTENT must be indented deeper than its key, so
  // these sit at 8 spaces under `text: |` at 6. Matching the key's indent makes
  // Quarto reject the profile outright.
  const header = latexPreamble(style);

  // The SAME settings go to `pdf` and `latex`. Quarto treats them as separate
  // format keys, and Nature accepts LaTeX at the acceptance stage — a .tex
  // export deserves the identical preamble, not a bare one.
  //
  // Engine: lualatex rather than Quarto's default xelatex. Unlike pdflatex it
  // handles the Unicode a science manuscript is full of natively — verified
  // here: pdflatex fails outright on "α (U+03B1)".
  for (const key of ["pdf", "latex"] as const) {
    const blk: string[] = [`  ${key}:`];
    if (key === "pdf") blk.push("    pdf-engine: lualatex");
    if (style.manuscript) {
      blk.push("    documentclass: article");
      if (d.paperSize) blk.push(`    papersize: ${d.paperSize}`);
      if (d.marginsIn) {
        const m = d.marginsIn;
        blk.push("    geometry:", `      - top=${m.top}in`, `      - bottom=${m.bottom}in`, `      - left=${m.left}in`, `      - right=${m.right}in`);
      }
      // Hyperlinks stay black text in a manuscript (no coloured boxes).
      blk.push("    colorlinks: false");
    } else if (d.fontFamily) blk.push(`    mainfont: ${q(d.fontFamily)}`);
    if (d.fontSizePt) blk.push(`    fontsize: ${d.fontSizePt}pt`);
    if (header.length) blk.push("    include-in-header:", "      text: |", ...header);
    fmt.push(...blk);
  }

  if (fmt.length) lines.push("format:", ...fmt);
  return lines.join("\n") + "\n";
}
