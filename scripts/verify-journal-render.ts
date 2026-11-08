#!/usr/bin/env -S npx tsx
// Journal export — REAL renders. A scaffolded project with a composed figure,
// a captioned model and the journal fixture manuscript is compiled through
// flux-core `compile` (the CLI/agent engine; Paper runs the same prep) for every
// venue, to Word and to PDF, and the ARTIFACTS are inspected:
//   Word — the venue's page setup reached the file (line numbering in the
//          section properties, page-number footer, fonts), the assembler's
//          custom styles survived pandoc, figures are 300-dpi PNGs (no 10–15 MB
//          SVGs), citations print in the venue's form, the summary is written;
//   PDF  — compiles with lualatex, is small (raster figures), and its text holds
//          the venue's title page, citation marks, legend and reference forms.
// The Quarto legs skip only when quarto (or lualatex, for PDF) is absent —
// CI provisions both (.github/workflows/ci.yml).
//   Run: node scripts/run-verifies.mjs --tier pure --only journal-render
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";

// Hermetic: no FluxLib/config of the user's machine (see guide §7).
const home = await fs.mkdtemp(path.join(os.tmpdir(), "flux-journal-render-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
const core = await import("../flux-core/index");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

async function pdfText(file: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: false, isEvalSupported: false }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map((it: any) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("") + "\n";
  }
  return out.replace(/[ \t]+/g, " ");
}

const hasQuarto = spawnSync("quarto", ["--version"], { stdio: "ignore" }).status === 0;
const hasLuaLatex = spawnSync("lualatex", ["--version"], { stdio: "ignore" }).status === 0;
const proj = await fs.mkdtemp(path.join(os.tmpdir(), "flux-journal-render-"));
try {
  if (!hasQuarto) {
    console.log("  (skip) quarto not on PATH — journal render legs skipped");
  } else {
    await core.scaffold(proj, { title: "Journal render" });
    const plot = path.join(proj, "plots", "p.svg");
    await fs.mkdir(path.dirname(plot), { recursive: true });
    await fs.writeFile(plot, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180" viewBox="0 0 300 180"><rect x="20" y="20" width="200" height="120" fill="#4385be"/><text x="40" y="90" font-size="20" font-family="Arial">data</text></svg>`);
    const comp = await core.composeFigure(proj, [plot, plot, plot], { id: "growth", captionStub: false });
    await core.setCaption(proj, comp.figureId, "Sleep raises synaptic APP. **a**, Design. **b**, APP blots [@villette2019]. **c**, Quantification.");
    const manifest = JSON.parse(await fs.readFile(path.join(proj, "project.json"), "utf8"));
    const docRel: string = manifest.manuscript.path;
    const docAbs = path.join(proj, docRel);
    const bibRel: string = manifest.references?.library ?? "references/library.bib";
    await fs.mkdir(path.dirname(path.join(proj, bibRel)), { recursive: true });
    await fs.copyFile("fixtures/journal-export/library.bib", path.join(proj, bibRel));
    const relBib = path.relative(path.dirname(docAbs), path.join(proj, bibRel)).split(path.sep).join("/");
    const render = path.relative(path.dirname(docAbs), path.join(proj, "fig", "renders", "growth.svg")).split(path.sep).join("/");
    // The fixture manuscript, pointed at this project's figure (the scaffold's
    // blank Figure 1 makes the composed one Figure 2) and bibliography.
    const fixture = (await fs.readFile("fixtures/journal-export/manuscript.qmd", "utf8"))
      .replace("bibliography: library.bib", `bibliography: ${relBib}`)
      .replace("![](fig-a.svg){#fig-a width=60%}", `![](${render}){#fig-growth width=60%}`)
      .replaceAll("@fig-a", "@fig-growth")
      .replace(" (@fig-s1)", "");
    await fs.writeFile(docAbs, fixture);
    const outBase = docAbs.replace(/\.qmd$/, "");

    for (const id of ["nature", "science", "cell", "biorxiv"]) {
      console.log(`${id} — Word:`);
      const r = await core.compile(proj, "docx", { style: id });
      if (r.code !== 0) console.error(r.log.slice(-3000));
      assert(r.code === 0 && r.output, `${id}: Quarto renders the Word manuscript`);
      const bytes = await fs.readFile(r.output!);
      const parts = unzipSync(new Uint8Array(bytes));
      const doc = strFromU8(parts["word/document.xml"]);
      const styles = strFromU8(parts["word/styles.xml"]);
      assert(/<w:lnNumType\b/.test(doc), `${id}: LINE NUMBERS reached the file (section properties from the venue's reference.docx)`);
      assert(/<w:footerReference\b/.test(doc) && Object.keys(parts).some((p) => /word\/footer\d*\.xml$/.test(p) && /PAGE/.test(strFromU8(parts[p]))), `${id}: page-number footer`);
      const media = Object.keys(parts).filter((p) => p.startsWith("word/media/"));
      assert(media.length >= 1 && media.every((p) => p.endsWith(".png")), `${id}: figures embedded as PNG only (got ${media.join(", ")})`);
      assert(bytes.length < 5_000_000, `${id}: the file stays small (${Math.round(bytes.length / 1024)} KB)`);
      const text = doc.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      assert(text.includes("Sleep-like OFF periods lower synaptic APP and tau"), `${id}: the title page is in the document`);
      const notes = `${outBase}.submission.md`;
      assert((await fs.readFile(notes, "utf8")).includes("# "), `${id}: the export summary is written beside the output`);
      if (id === "nature") {
        assert(/w:ascii="Times New Roman"/.test(styles) && /w:line="480"/.test(styles), "nature: Times New Roman, double-spaced");
        assert(/w:val="Title"/.test(doc) && /w:val="FigureLegend"/.test(doc) && /w:val="Bibliography"/.test(doc), "nature: assembler blocks keep their custom styles through pandoc");
        assert(/<w:vertAlign w:val="superscript"\s*\/>/.test(doc), "nature: superscript citation marks");
        assert(text.includes("Fig. 2 | Sleep raises synaptic APP.") && text.includes("Hanse, E., Seth, H. & Riebe, I."), "nature: legend lead and reference form");
        assert(!/Introduction/.test(text.split("References")[0]), "nature: no Introduction heading");
      }
      if (id === "science") {
        assert(/w:countBy="5"/.test(doc) && /Submitted Manuscript: Confidential/.test(Object.keys(parts).filter((p) => /header/.test(p)).map((p) => strFromU8(parts[p])).join("")), "science: every-5th-line numbering and the template's running header");
        assert(/w:val="Head"/.test(doc) && /w:val="AbstractSummary"/.test(doc) && /w:val="Referencesandnotes"/.test(doc), "science: the template's own style names");
        assert(text.includes("Abstract:") && text.includes("Main Text:") && text.includes("References and Notes") && text.includes("E. Hanse, H. Seth, I. Riebe,"), "science: key words and reference form");
      }
      if (id === "cell") {
        assert(/w:ascii="Arial"/.test(styles), "cell: Arial");
        assert(text.includes("SUMMARY") && text.includes("RESOURCE AVAILABILITY") && text.includes("STAR METHODS") && text.includes("Figures 2B and 2C"), "cell: ALL-CAPS structure and Figures 2B and 2C");
      }
      if (id === "biorxiv") {
        assert(/w:ascii="Arial"/.test(styles) && text.includes("Abstract"), "biorxiv: preprint layout with an Abstract heading");
      }

      console.log(`${id} — PDF:`);
      if (!hasLuaLatex) {
        console.log("  (skip) lualatex not on PATH — journal PDF leg skipped");
        continue;
      }
      const p = await core.compile(proj, "pdf", { style: id });
      if (p.code !== 0) console.error(p.log.slice(-3000));
      assert(p.code === 0 && p.output, `${id}: lualatex renders the PDF manuscript`);
      const pdf = await fs.readFile(p.output!);
      assert(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length < 5_000_000, `${id}: a valid, small PDF (${Math.round(pdf.length / 1024)} KB)`);
      const t = await pdfText(p.output!);
      assert(t.includes("Sleep-like OFF periods lower synaptic APP and tau"), `${id}: PDF title page`);
      if (id === "nature") assert(/Fig\. 2 \| Sleep raises synaptic APP\./.test(t) && /Hanse, E\., Seth, H\. & Riebe, I\./.test(t) && /Methods/.test(t), "nature PDF: legend, references, Methods");
      if (id === "science") assert(/Abstract:/.test(t) && /\(1\)/.test(t) && /Submitted Manuscript: Confidential/.test(t), "science PDF: key words, (1) citations, running header");
      if (id === "cell") assert(/RESOURCE AVAILABILITY/.test(t) && /Figure 2\. Sleep raises synaptic APP/.test(t), "cell PDF: structure and legend");
      if (id === "biorxiv") assert(/Abstract/.test(t) && /Figure 2\. Sleep raises synaptic APP\./.test(t), "biorxiv PDF: abstract and inline legend");
      const leftovers = (await fs.readdir(path.dirname(docAbs))).filter((f) => f.startsWith(".flux-journal-figures-"));
      assert(leftovers.length === 0, `${id}: the per-render figure rasters are removed`);
    }
    assert((await fs.readFile(docAbs, "utf8")) === fixture, "the authored manuscript is restored byte-identical after every render");
  }
  console.log("\nJOURNAL-RENDER VERIFY: PASS");
} finally {
  if (!process.env.KEEP) await fs.rm(proj, { recursive: true, force: true }); else console.log("kept", proj);
  await fs.rm(home, { recursive: true, force: true });
}
