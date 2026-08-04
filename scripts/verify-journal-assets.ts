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
  assert(ncPlan.every((a) => a.resource.includes("nature.") || a.resource.includes("nature-reference")),
    "…specifically Nature's, inherited through `extends`");
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

// --- the generated profile ---------------------------------------------------
{
  const yaml = journalProfileYaml(nature, { manuscriptDir: "manuscript" });
  assert(EXPORT_PROFILE_FILE === `_quarto-${EXPORT_PROFILE}.yml`,
    "the profile filename follows Quarto's _quarto-<profile>.yml convention");
  // Paths are relative to the QUARTO PROJECT dir (the manuscript folder), while
  // the asset plan is project-root relative — confusing the two frames produces
  // a profile Quarto accepts and silently ignores.
  assert(yaml.includes("csl: ../references/styles/nature.csl"),
    "csl path is written relative to the manuscript directory");
  assert(yaml.includes("reference-doc: ../styles/journal/nature/reference.docx"),
    "reference-doc path likewise");
  assert(yaml.includes("pdf-engine: lualatex"),
    "the PDF engine is lualatex (pdflatex cannot set Unicode text such as α)");
  assert(yaml.includes('mainfont: "Times New Roman"'), "mainfont is quoted (it contains spaces)");
  assert(yaml.includes("fontsize: 12pt"), "12pt");

  // The literal block: content MUST be indented deeper than its key.
  const lines = yaml.split("\n");
  const textIdx = lines.findIndex((l) => /^\s+text: \|$/.test(l));
  assert(textIdx > 0, "an include-in-header literal block is emitted");
  const keyIndent = lines[textIdx].match(/^\s*/)![0].length;
  const bodyIndent = lines[textIdx + 1].match(/^\s*/)![0].length;
  assert(bodyIndent > keyIndent,
    `literal-block content is indented deeper than 'text: |' (${bodyIndent} > ${keyIndent})`);
  assert(yaml.includes("\\usepackage{lineno}") && yaml.includes("\\linenumbers"), "line numbers requested");
  assert(yaml.includes("\\usepackage{setspace}") && yaml.includes("\\doublespacing"), "double spacing requested");

  // Both format keys: Quarto treats pdf and latex separately, and Nature takes
  // LaTeX at acceptance.
  assert(/^ {2}pdf:$/m.test(yaml) && /^ {2}latex:$/m.test(yaml),
    "BOTH pdf and latex formats carry the settings");
  assert((yaml.match(/\\linenumbers/g) ?? []).length === 2, "…including the preamble, once per format");

  // Nested manuscript directories get the right number of `../`.
  const deep = journalProfileYaml(nature, { manuscriptDir: "manuscript/sub" });
  assert(deep.includes("csl: ../../references/styles/nature.csl"),
    "a nested manuscript dir climbs the right number of levels");

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
