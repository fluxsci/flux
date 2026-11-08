#!/usr/bin/env -S npx tsx
// 2026-11-08 — the citation-style (CSL) picker's pure half. The picker copies a
// CSL into `references/styles/` and writes the document's `csl:` through the
// byte-minimal front-matter editor; the Word export's resolver must then read
// THAT file. Pinned here:
//   (a) every shipped CSL under resources/csl parses (title, Zotero id, format);
//   (b) the document-relative `csl:` path round-trips for nested documents;
//   (c) writing `csl:` changes only that line (affiliations/comments intact);
//   (d) resolveCslIdentity (the export's shared resolver) reads the written
//       value back to the copied style — Zotero/Word and the render agree;
//   (e) the writer stays neutral: nothing in the picker's modules touches the
//       editor's citation chips (only `csl:` is written).
//   node scripts/run-verifies.mjs --tier pure --only csl-picker

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { cslInfo, cslFileName, cslProjectRel, cslFrontMatterValue, cslTargetOf, CSL_PROJECT_DIR } from "../src/lib/references/cslCatalog";
import { planSetScalarKeyWith, applyFmChanges } from "../src/shell/modes/paper/frontmatterEdit";
import { resolveCslIdentity } from "../src/lib/references/zoteroFields";
import { journalAssetPlan } from "../src/lib/style/journalAssets";
import { resolveJournalStyle } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const eq = (a: unknown, b: unknown, m: string) =>
  JSON.stringify(a) === JSON.stringify(b) ? ok(m) : fail(`${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---- (a) shipped styles ---------------------------------------------------------------
const cslDir = path.resolve("resources/csl");
const shipped = fs.readdirSync(cslDir).filter((f) => f.endsWith(".csl")).sort();
assert(shipped.length >= 3, `resources/csl ships styles (${shipped.join(", ")})`);
for (const f of shipped) {
  const info = cslInfo(fs.readFileSync(path.join(cslDir, f), "utf8"));
  assert(info && info.title && /^https?:\/\/www\.zotero\.org\/styles\//.test(info.id) && info.format, `${f}: ${info?.title} · ${info?.format}`);
}
assert(cslInfo("<html><title>x</title></html>") === null, "a non-CSL file is refused");
// The journal styles provision the SAME project path the picker writes.
const nature = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);
eq(journalAssetPlan(nature).find((a) => a.rel.endsWith(".csl"))?.rel, cslProjectRel("nature.csl"), "picker and journal style share references/styles/<id>.csl");

// ---- (b) document-relative paths -------------------------------------------------------
eq(cslFrontMatterValue("paper/notes.qmd", "references/styles/nature.csl"), "../references/styles/nature.csl", "paper/notes.qmd → ../references/styles/…");
eq(cslFrontMatterValue("paper/a/b/x.qmd", "references/styles/cell.csl"), "../../../references/styles/cell.csl", "nested document climbs out");
eq(cslFrontMatterValue("main.qmd", "references/styles/cell.csl"), "references/styles/cell.csl", "root document");
eq(cslFrontMatterValue("references/notes.qmd", "references/styles/cell.csl"), "styles/cell.csl", "shared prefix is not climbed");
for (const doc of ["paper/notes.qmd", "paper/a/b/x.qmd", "main.qmd", "references/notes.qmd"]) {
  const v = cslFrontMatterValue(doc, "references/styles/cell.csl");
  eq(cslTargetOf(doc, v), "references/styles/cell.csl", `round trip from ${doc}`);
}
eq(cslTargetOf("paper/x.qmd", "../../outside.csl"), null, "a path leaving the project is not a project style");
eq(cslFileName("My Style (v2).CSL"), "my-style-v2.csl", "loaded file names are slugged");
eq(cslFileName("/home/u/Downloads/journal-of-neuroscience.csl"), "journal-of-neuroscience.csl", "a full path keeps its base name");
assert(CSL_PROJECT_DIR === "references/styles", "styles land beside the bibliography");

// ---- (c) the front-matter write is one line -------------------------------------------
const DOC = `---
title: "Spindles"   # working
author:
  - name: Ada Lovelace
    affiliations: [ucl]
    orcid: 0000-0002-1825-0097
bibliography: ../references/library.bib
---

Text [@smith2021].
`;
const setCsl = (src: string, v: string | null) => applyFmChanges(src, planSetScalarKeyWith(yaml, src, "csl", v));
const withCsl = setCsl(DOC, cslFrontMatterValue("paper/notes.qmd", "references/styles/nature.csl"));
eq(withCsl, DOC.replace("bibliography: ../references/library.bib\n", "bibliography: ../references/library.bib\ncsl: ../references/styles/nature.csl\n"), "picking a style adds one `csl:` line, nothing else");
eq(setCsl(withCsl, "../references/styles/cell.csl"), withCsl.replace("nature.csl", "cell.csl"), "switching styles rewrites only the value");
eq(setCsl(withCsl, null), DOC, "Default removes the line and restores the exact original");

// ---- (d) the export resolver reads what the picker wrote --------------------------------
{
  const root = "/proj";
  const files = new Map<string, string>([
    [`${root}/paper/notes.qmd`, withCsl],
    [`${root}/references/styles/nature.csl`, fs.readFileSync(path.join(cslDir, "nature.csl"), "utf8")],
  ]);
  const norm = (p: string) => path.posix.normalize(p);
  const identity = await resolveCslIdentity(async (p) => files.get(norm(p)) ?? null, { root, docPath: `${root}/paper/notes.qmd` });
  eq(identity.styleId, "http://www.zotero.org/styles/nature", "resolveCslIdentity follows the written csl: to the copied style");
  files.set(`${root}/paper/notes.qmd`, DOC);
  const none = await resolveCslIdentity(async (p) => files.get(norm(p)) ?? null, { root, docPath: `${root}/paper/notes.qmd` });
  eq(none.styleId, "http://www.zotero.org/styles/chicago-author-date", "without csl: Pandoc's default is declared");
}

// ---- (e) writer neutrality: the picker writes only `csl:` -------------------------------
{
  const dialog = fs.readFileSync("src/shell/modes/paper/ExportDialog.svelte", "utf8");
  const mode = fs.readFileSync("src/shell/modes/paper/PaperMode.svelte", "utf8");
  const setter = /async function setDocumentCsl[\s\S]*?\n {2}\}\n/.exec(mode)?.[0] ?? "";
  assert(setter.includes('planSetScalarKey') && !/citation-style|setCitationStyle/.test(setter), "the picker writes `csl:` only (never the editor's citation-style)");
  assert(/aria-label="Reference style"/.test(dialog), "the Export dialog carries the Reference style picker");
}

console.log(failures ? `\nCSL-PICKER: FAIL (${failures})` : "\nCSL-PICKER: PASS");
process.exit(failures ? 1 : 0);
