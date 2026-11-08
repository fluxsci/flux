#!/usr/bin/env -S npx tsx
// Journal export assets: the Quarto profile, the asset plan, the shipped files,
// and the failure diagnosis.
//
// The profile is how a journal style reaches Quarto WITHOUT Flux ever editing
// the user's _quarto.yml or their front matter, so its exact shape matters:
// a literal block indented wrong, or a path in the wrong frame of reference,
// and Quarto silently ignores or rejects it.
//   Run: npx tsx scripts/verify-journal-assets.ts
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  EXPORT_PROFILE,
  EXPORT_PROFILE_FILE,
  diagnoseQuartoFailure,
  journalAssetPlan,
  journalProfileYaml,
  journalRenderMeta,
  JOURNAL_LUA_REL,
} from "../src/lib/style/journalAssets";
import { resolveJournalStyle } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const nature = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);

// --- asset plan --------------------------------------------------------------
{
  const plan = journalAssetPlan(nature);
  const csl = plan.find((a) => a.rel.endsWith(".csl"));
  const docx = plan.find((a) => a.rel.endsWith(".docx"));
  assert(csl?.rel === "references/styles/nature.csl",
    "the CSL lands in references/styles/ — the directory the scaffold has always created for it");
  assert(docx?.rel === "styles/journal/nature/reference.docx",
    "the Word reference doc lands in styles/journal/<style>/");
  for (const a of plan) {
    assert(existsSync(`resources/${a.resource}`), `the shipped resource resources/${a.resource} exists`);
  }
  assert(journalAssetPlan(resolveJournalStyle(null, BUILTIN_JOURNAL_STYLES)).length === 0,
    "the house style needs NO assets (nothing is written for a plain export)");

  // A style that EXTENDS another must reuse its parent's shipped files. Keying
  // assets off the leaf id instead made nature-communications ask for a CSL and
  // a reference.docx that do not ship, and the export failed outright.
  const nc = resolveJournalStyle("nature-communications", BUILTIN_JOURNAL_STYLES);
  const ncPlan = journalAssetPlan(nc);
  assert(ncPlan.length === plan.length, "an extending style plans the same number of assets");
  for (const a of ncPlan) {
    assert(existsSync(`resources/${a.resource}`),
      `nature-communications reuses a SHIPPED resource (${a.resource}), not one named after itself`);
  }
  assert(ncPlan.every((a) => a.resource.includes("nature.") || a.resource.includes("nature-reference") || a.resource === "lua/flux-journal.lua"),
    "…specifically Nature's (or the one Lua filter every journal shares), inherited through `extends`");
  // Every journal style ships its full asset set.
  for (const id of ["nature", "science", "cell", "biorxiv"]) {
    const plan = journalAssetPlan(resolveJournalStyle(id, BUILTIN_JOURNAL_STYLES));
    for (const a of plan) assert(existsSync(`resources/${a.resource}`), `${id}: the shipped resource resources/${a.resource} exists`);
    assert(plan.some((a) => a.rel === `styles/journal/${id}/reference.docx`), `${id}: plans its own Word template`);
    assert(plan.some((a) => a.rel === JOURNAL_LUA_REL), `${id}: plans the PDF-path Lua filter`);
  }
}

// --- the shipped files are the real thing ------------------------------------
{
  const csl = readFileSync("resources/csl/nature.csl", "utf8");
  assert(/<id>http:\/\/www\.zotero\.org\/styles\/nature<\/id>/.test(csl),
    "nature.csl is the canonical Zotero-repo style, not a hand-rolled approximation");
  assert(/creativecommons\.org\/licenses\/by-sa/.test(csl),
    "…and carries its CC BY-SA licence header (attribution preserved)");
  // Independent confirmation of the rule measured from the PDF corpus: at 6+
  // authors Nature prints the first author alone.
  assert(/et-al-min="6"/.test(csl) && /et-al-use-first="1"/.test(csl),
    "the CSL's own et-al rule matches the corpus measurement (>=6 authors → first + et al.)");

  // The Word template carries what pandoc copies from a reference-doc.
  const zipList = execFileSync("unzip", ["-p", "resources/docx/nature-reference.docx", "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert(/<w:lnNumType[^>]*w:countBy="1"[^>]*\/>/.test(zipList),
    "the Word template carries LINE NUMBERING in its section properties");
  const styles = execFileSync("unzip", ["-p", "resources/docx/nature-reference.docx", "word/styles.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert(/w:ascii="Times New Roman"/.test(styles), "…Times New Roman as the document default");
  assert(/<w:sz w:val="24" \/>/.test(styles), "…12pt (24 half-points)");
  assert(/w:line="480" w:lineRule="auto"/.test(styles), "…and double spacing (480 = 2x240, auto rule)");
}

// --- render settings: front matter for journal styles, a profile for the rest ---
{
  // Superseded 2026-11: a journal style's settings no longer travel in the
  // `--profile` file. Quarto reads `_quarto-<profile>.yml` only from the Quarto
  // PROJECT directory, so a manuscript one folder below _quarto.yml
  // (paper/MANUSCRIPT_MAIN/manuscript.qmd) rendered with NONE of them — no
  // reference.docx, no line numbers (found exporting the owner's molecular paper).
  // They now go into the prepared copy's front matter, which Quarto always reads.
  assert(EXPORT_PROFILE_FILE === `_quarto-${EXPORT_PROFILE}.yml`,
    "the profile filename follows Quarto's _quarto-<profile>.yml convention");
  const prof = journalProfileYaml(nature, { manuscriptDir: "manuscript" });
  assert(!/^(format|csl|filters):/m.test(prof), "a journal style's profile carries no settings of its own");

  const meta = journalRenderMeta(nature, { docDir: "manuscript" }) as any;
  assert(meta.format.docx["reference-doc"] === "../styles/journal/nature/reference.docx",
    "reference-doc path is relative to the DOCUMENT's directory");
  assert(meta.filters?.[0] === `../${JOURNAL_LUA_REL}`, "the Lua filter is wired in, document-relative");
  assert(!("csl" in meta), "a literal-citation style hands pandoc no CSL (nothing is left for citeproc)");
  assert(meta.format.pdf["pdf-engine"] === "lualatex",
    "the PDF engine is lualatex (pdflatex cannot set Unicode text such as α)");
  assert(meta.format.pdf.fontsize === "12pt", "12pt");
  const header: string = meta.format.pdf["include-in-header"].text;
  // A missing font must not fail the render: Times New Roman is absent on most
  // Linux machines, so the preamble falls back through installed equivalents.
  assert(header.includes("\\IfFontExistsTF{Times New Roman}") && header.includes("TeX Gyre Termes"),
    "the font is set through a fallback chain (Times New Roman → TeX Gyre Termes → …)");
  assert(header.includes("\\usepackage{lineno}") && header.includes("\\linenumbers"), "line numbers requested");
  assert(header.includes("\\usepackage{setspace}") && header.includes("\\doublespacing"), "double spacing requested");
  assert(!header.includes("titlesec"), "no titlesec — a minimal TeX install lacks it (heads use \\@startsection)");
  assert(meta.format.latex["include-in-header"].text === header, "BOTH pdf and latex formats carry the identical preamble");
  assert(meta.crossref["title-delim"] === "|", "Nature tables read 'Table 1 | …'");

  const deep = journalRenderMeta(nature, { docDir: "paper/MANUSCRIPT_MAIN" }) as any;
  assert(deep.format.docx["reference-doc"] === "../../styles/journal/nature/reference.docx",
    "a nested document climbs the right number of levels");
  const sci = journalRenderMeta(resolveJournalStyle("science", BUILTIN_JOURNAL_STYLES), { docDir: "" }) as any;
  assert(sci.format.pdf["include-in-header"].text.includes("\\modulolinenumbers[5]"), "Science numbers every 5th line");
  assert(sci.format.pdf["include-in-header"].text.includes("Submitted Manuscript: Confidential"), "…and carries its template's running header");
  assert(sci.format.pdf.papersize === "letter", "…on US Letter");

  // The house style writes no profile-worthy content at all.
  const house = journalProfileYaml(resolveJournalStyle(null, BUILTIN_JOURNAL_STYLES));
  assert(!house.includes("csl:") && !house.includes("reference-doc:"),
    "the house style's profile references no assets");
}

// --- failure diagnosis -------------------------------------------------------
// Each of these was hit for real while building this; the raw logs are a Lua
// stack trace or a TeX rerun, and unreadable without the translation.
{
  assert(/librsvg2-bin/.test(diagnoseQuartoFailure("call_rsvg_convert failed: rsvg-convert not found") ?? ""),
    "a missing rsvg-convert names the package that provides it");
  assert(/texlive-humanities/.test(
    diagnoseQuartoFailure("! LaTeX Error: File `lineno.sty' not found.") ?? ""),
    "a missing .sty names both the tlmgr and the distro route");
  assert(/texlive-luatex/.test(diagnoseQuartoFailure("Error in luaotfload: reverting to OT1") ?? ""),
    "a missing luaotfload is recognised (lualatex present, loader absent)");
  assert(/texlive-fonts-recommended/.test(
    diagnoseQuartoFailure("Font OT1/ptm/m/n/12=ptmr7t at 12.0pt not loadable: Metric (TFM) file not found") ?? ""),
    "missing font metrics are recognised");
  assert(diagnoseQuartoFailure("Output created: main.docx") === null,
    "a clean log produces no spurious diagnosis");
}

console.log("\nJOURNAL-ASSETS VERIFY: PASS");
