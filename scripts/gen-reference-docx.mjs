#!/usr/bin/env node
// Generate the journal Word reference-doc templates.
//
// A submission manuscript is double-spaced, 12pt Times New Roman, with LINE
// NUMBERS. In Word those are not paragraph properties — line numbering is a
// SECTION property (`w:lnNumType` inside `w:sectPr`), and pandoc copies the
// section properties (and styles) from whatever `--reference-doc` it is given.
// So the way to get a compliant .docx out of Quarto is to hand it a reference
// doc that already carries them.
//
// This script builds that file from pandoc's OWN default reference.docx, so the
// result stays in step with the pandoc version in use and the repo carries a
// reproducible artifact rather than an opaque binary someone hand-made once.
//
//   node scripts/gen-reference-docx.mjs
//
// Writes resources/docx/<style>-reference.docx. Re-run after a pandoc upgrade;
// verify-journal-assets.ts checks the committed files still carry the marks.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Word measures spacing in twentieths of a point; 240 = single at 12pt. */
const LINE_240 = 240;

const TEMPLATES = [
  {
    id: "nature",
    // [CD] nature.com: "Double-spaced … preferably 12-point Times New Roman"
    // plus "Please include line numbers within the text."
    font: "Times New Roman",
    sizePt: 12,
    lineSpacing: 2,
    lineNumbers: true,
  },
];

function docDefaults(xml, { font, sizePt, lineSpacing }) {
  const half = String(sizePt * 2); // Word stores font size in half-points
  const line = String(Math.round(LINE_240 * lineSpacing));
  // Set the document-wide defaults so EVERY style inherits them, rather than
  // patching Normal alone and leaving headings/captions on the theme font.
  let out = xml.replace(
    /<w:rFonts w:asciiTheme="minorHAnsi"[^/]*\/>/,
    `<w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}" />`,
  );
  out = out.replace(
    /<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<w:sz w:val="\d+" \/>\s*<w:szCs w:val="\d+" \/>/,
    (_m, head) => `<w:rPrDefault><w:rPr>${head}<w:sz w:val="${half}" /><w:szCs w:val="${half}" />`,
  );
  // `lineRule="auto"` makes the value a MULTIPLE of single spacing, which is
  // what "double-spaced" means to a copy editor — an exact height would break
  // as soon as a superscript or a larger glyph appears on the line.
  out = out.replace(
    /<w:pPrDefault>\s*<w:pPr>\s*<w:spacing w:after="\d+" \/>\s*<\/w:pPr>\s*<\/w:pPrDefault>/,
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${line}" w:lineRule="auto" /></w:pPr></w:pPrDefault>`,
  );
  return out;
}

function addLineNumbers(xml) {
  // countBy=1 numbers every line; restart="continuous" runs straight through
  // the manuscript rather than restarting per page, which is what reviewers
  // reference ("line 412"), not a per-page number.
  const mark = '<w:lnNumType w:countBy="1" w:restart="continuous" />';
  if (xml.includes("<w:sectPr />")) return xml.replace("<w:sectPr />", `<w:sectPr>${mark}</w:sectPr>`);
  if (/<w:sectPr[^>]*>/.test(xml)) return xml.replace(/(<w:sectPr[^>]*>)/, `$1${mark}`);
  // No section properties at all — append one before the body closes.
  return xml.replace("</w:body>", `<w:sectPr>${mark}</w:sectPr></w:body>`);
}

const repo = path.resolve(import.meta.dirname, "..");
const outDir = path.join(repo, "resources", "docx");
mkdirSync(outDir, { recursive: true });

for (const t of TEMPLATES) {
  const work = mkdtempSync(path.join(tmpdir(), `flux-refdoc-${t.id}-`));
  try {
    const base = path.join(work, "base.docx");
    writeFileSync(base, execFileSync("pandoc", ["--print-default-data-file", "reference.docx"], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
    }));
    const x = path.join(work, "x");
    execFileSync("unzip", ["-o", "-q", base, "-d", x]);

    const stylesPath = path.join(x, "word", "styles.xml");
    writeFileSync(stylesPath, docDefaults(readFileSync(stylesPath, "utf8"), t));

    if (t.lineNumbers) {
      const docPath = path.join(x, "word", "document.xml");
      writeFileSync(docPath, addLineNumbers(readFileSync(docPath, "utf8")));
    }

    const out = path.join(outDir, `${t.id}-reference.docx`);
    rmSync(out, { force: true });
    // Zip from inside the extracted tree so paths are archive-relative.
    execFileSync("zip", ["-q", "-r", "-X", out, "."], { cwd: x });
    console.log(`wrote ${path.relative(repo, out)} (${t.font} ${t.sizePt}pt, ${t.lineSpacing}× spacing, line numbers: ${t.lineNumbers})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
