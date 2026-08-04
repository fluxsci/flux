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
  if (style.csl) out.push({ rel: style.csl, resource: `csl/${style.id}.csl` });
  if (style.document.lineNumbers || style.document.fontFamily || style.document.lineSpacing) {
    out.push({
      rel: `styles/journal/${style.id}/reference.docx`,
      resource: `docx/${style.id}-reference.docx`,
    });
  }
  return out;
}

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
  if (/rsvg[-_ ]?convert/i.test(log)) {
    return (
      "Quarto needs `rsvg-convert` to place SVG figures in a PDF. " +
      "Install it: librsvg2-bin (Debian/Ubuntu), librsvg (Homebrew/Arch)."
    );
  }
  const missingSty = /! LaTeX Error: File `([\w.-]+)\.sty' not found/.exec(log);
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
    return "No LaTeX engine found. Install TinyTeX (`quarto install tinytex`) for PDF output.";
  }
  return null;
}

/** YAML-quote a scalar. Keeps the generated profile valid for fonts with
 *  spaces ("Times New Roman") without pulling in a YAML writer. */
function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  const header: string[] = [];
  if (d.lineNumbers) header.push("        \\usepackage{lineno}", "        \\linenumbers");
  if (d.lineSpacing && d.lineSpacing > 1) {
    header.push(
      "        \\usepackage{setspace}",
      d.lineSpacing >= 2 ? "        \\doublespacing" : "        \\onehalfspacing",
    );
  }

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
    if (d.fontFamily) blk.push(`    mainfont: ${q(d.fontFamily)}`);
    if (d.fontSizePt) blk.push(`    fontsize: ${d.fontSizePt}pt`);
    if (header.length) blk.push("    include-in-header:", "      text: |", ...header);
    fmt.push(...blk);
  }

  if (fmt.length) lines.push("format:", ...fmt);
  return lines.join("\n") + "\n";
}
