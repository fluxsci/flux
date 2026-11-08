#!/usr/bin/env node
// Generate the journal Word reference-doc templates.
//
// A submission manuscript's page setup lives in places pandoc COPIES from the
// `--reference-doc` it is given: the styles (fonts, spacing, headings, the
// custom styles Flux's journal assembler tags blocks with), and the section
// properties — page size, margins, LINE NUMBERS (`w:lnNumType` is a section
// property, not a paragraph one), and the header/footer parts (page numbers,
// Science's running header). So the way to get a compliant .docx out of Quarto
// is to hand it a reference doc that already carries all of them.
//
// This script builds each file from pandoc's OWN default reference.docx, so the
// result stays in step with the pandoc version in use and the repo carries a
// reproducible artifact rather than an opaque binary someone hand-made once.
//
//   node scripts/gen-reference-docx.mjs
//
// Writes resources/docx/<style>-reference.docx. Re-run after a pandoc upgrade;
// verify-journal-assets.ts checks the committed files still carry the marks.
// The page values come from docs/journal_styleguide.md (§2.4 Nature, §3.4
// Science — its Nov-2022 template, §4.5 Cell, bioRxiv: house preprint layout).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Word measures spacing in twentieths of a point; 240 = single at 12pt. */
const LINE_240 = 240;
const TWIPS_PER_IN = 1440;

const TEMPLATES = [
  {
    // [CD] nature.com: "Double-spaced … preferably 12-point Times New Roman"
    // plus "Please include line numbers within the text."
    id: "nature",
    font: "Times New Roman",
    sizePt: 12,
    lineSpacing: 2,
    lineNumbers: true,
    countBy: 1,
    paper: "letter",
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    pageNumbers: true,
    title: { sizePt: 16, align: "left" },
    authorAlign: "left",
    headings: [
      { bold: true, italic: false, sizePt: 12 },
      { bold: true, italic: false, sizePt: 12 },
      { bold: false, italic: true, sizePt: 12 },
    ],
  },
  {
    // [D] Science template 2022: single-spaced 12pt Times, US Letter, margins
    // 0.9/1.0 in, line numbers every 5th line, page numbers, running header,
    // 0.5 in first-line indent; headings bold / bold italic / italic.
    id: "science",
    font: "Times New Roman",
    sizePt: 12,
    lineSpacing: 1,
    lineNumbers: true,
    countBy: 5,
    paper: "letter",
    margins: { top: 0.9, right: 1, bottom: 0.9, left: 1 },
    pageNumbers: true,
    header: "Submitted Manuscript: Confidential",
    firstLineIndentIn: 0.5,
    paragraphAfterPt: 0,
    title: { sizePt: 14, align: "center" },
    authorAlign: "center",
    headings: [
      { bold: true, italic: false, sizePt: 12 },
      { bold: true, italic: true, sizePt: 12 },
      { bold: false, italic: true, sizePt: 12 },
    ],
    // The template's own style names, so Science's extraction finds each block.
    extraStyles: ["Head", "Authors", "Affiliations", "AbstractSummary", "Teaser", "Refhead", "Referencesandnotes", "Acknowledgement", "SOMHead", "SOMContent", "Legend"],
  },
  {
    // No official Cell page setup (format-free initial submission): owner
    // ruling — 12 pt Arial, double-spaced, line and page numbers, US Letter.
    // Headings follow the Cell Press template: ALL CAPS bold (text is upper-cased
    // by the assembler), subsections sentence case bold.
    id: "cell",
    font: "Arial",
    sizePt: 12,
    lineSpacing: 2,
    lineNumbers: true,
    countBy: 1,
    paper: "letter",
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    pageNumbers: true,
    title: { sizePt: 14, align: "left" },
    authorAlign: "left",
    headings: [
      { bold: true, italic: false, sizePt: 12 },
      { bold: true, italic: false, sizePt: 12 },
      { bold: true, italic: true, sizePt: 12 },
    ],
  },
  {
    // bioRxiv sets no style; a readable preprint: 11 pt Arial, 1.5 spacing,
    // line numbers for reviewers' comments, page numbers.
    id: "biorxiv",
    font: "Arial",
    sizePt: 11,
    lineSpacing: 1.5,
    lineNumbers: true,
    countBy: 1,
    paper: "letter",
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    pageNumbers: true,
    title: { sizePt: 18, align: "left" },
    authorAlign: "left",
    headings: [
      { bold: true, italic: false, sizePt: 13 },
      { bold: true, italic: false, sizePt: 11 },
      { bold: true, italic: true, sizePt: 11 },
    ],
  },
];

const half = (pt) => String(Math.round(pt * 2));
const twips = (inch) => String(Math.round(inch * TWIPS_PER_IN));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function docDefaults(xml, { font, sizePt, lineSpacing }) {
  const line = String(Math.round(LINE_240 * lineSpacing));
  // Set the document-wide defaults so EVERY style inherits them, rather than
  // patching Normal alone and leaving headings/captions on the theme font.
  let out = xml.replace(
    /<w:rFonts w:asciiTheme="minorHAnsi"[^/]*\/>/,
    `<w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}" />`,
  );
  out = out.replace(
    /<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<w:sz w:val="\d+" \/>\s*<w:szCs w:val="\d+" \/>/,
    (_m, head) => `<w:rPrDefault><w:rPr>${head}<w:sz w:val="${half(sizePt)}" /><w:szCs w:val="${half(sizePt)}" />`,
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

/** Replace (or add) one style definition, keyed by its style id. */
function upsertStyle(xml, id, styleXml) {
  const re = new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`);
  if (re.test(xml)) return xml.replace(re, styleXml);
  return xml.replace("</w:styles>", `${styleXml}</w:styles>`);
}

function rPr({ font, sizePt, bold, italic, caps, color = "000000" }) {
  return (
    "<w:rPr>" +
    (font ? `<w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}" />` : "") +
    (bold ? "<w:b /><w:bCs />" : "<w:b w:val=\"0\" /><w:bCs w:val=\"0\" />") +
    (italic ? "<w:i /><w:iCs />" : "<w:i w:val=\"0\" /><w:iCs w:val=\"0\" />") +
    (caps ? "<w:caps />" : "") +
    `<w:color w:val="${color}" />` +
    (sizePt ? `<w:sz w:val="${half(sizePt)}" /><w:szCs w:val="${half(sizePt)}" />` : "") +
    "</w:rPr>"
  );
}

function paraStyle(id, name, { basedOn = "Normal", next, pPr = "", rpr = "", custom = true, qFormat = true }) {
  return (
    `<w:style w:type="paragraph"${custom ? ' w:customStyle="1"' : ""} w:styleId="${id}">` +
    `<w:name w:val="${name}" />` +
    (basedOn ? `<w:basedOn w:val="${basedOn}" />` : "") +
    (next ? `<w:next w:val="${next}" />` : "") +
    (qFormat ? "<w:qFormat />" : "") +
    (pPr ? `<w:pPr>${pPr}</w:pPr>` : "") +
    rpr +
    "</w:style>"
  );
}

function styleSet(t) {
  const after = t.paragraphAfterPt ?? (t.lineSpacing >= 2 ? 0 : 6);
  const indent = t.firstLineIndentIn ? `<w:ind w:firstLine="${twips(t.firstLineIndentIn)}" />` : "";
  const plainRun = rPr({ font: t.font, sizePt: t.sizePt, bold: false, italic: false });
  const styles = [];
  // Body: pandoc's Body Text / First Paragraph / Compact.
  styles.push(["BodyText", paraStyle("BodyText", "Body Text", { custom: false, next: "BodyText", pPr: `<w:spacing w:before="0" w:after="${after * 20}" />${indent}` })]);
  styles.push(["FirstParagraph", paraStyle("FirstParagraph", "First Paragraph", { basedOn: "BodyText", next: "BodyText" })]);
  styles.push(["Compact", paraStyle("Compact", "Compact", { basedOn: "BodyText", pPr: '<w:spacing w:before="0" w:after="0" /><w:ind w:firstLine="0" />' })]);
  // Headings: black, in the body font, venue weights.
  t.headings.forEach((h, i) => {
    const id = `Heading${i + 1}`;
    styles.push([id, paraStyle(id, `Heading ${i + 1}`, {
      custom: false,
      next: "BodyText",
      pPr: `<w:keepNext /><w:keepLines /><w:spacing w:before="${i === 0 ? 240 : 180}" w:after="${i === 0 ? 120 : 60}" /><w:outlineLvl w:val="${i}" />`,
      rpr: rPr({ font: t.font, sizePt: h.sizePt, bold: h.bold, italic: h.italic }),
    })]);
  });
  for (let i = t.headings.length; i < 6; i++) {
    const id = `Heading${i + 1}`;
    styles.push([id, paraStyle(id, `Heading ${i + 1}`, {
      custom: false,
      next: "BodyText",
      pPr: `<w:keepNext /><w:keepLines /><w:spacing w:before="120" w:after="0" /><w:outlineLvl w:val="${i}" />`,
      rpr: rPr({ font: t.font, sizePt: t.sizePt, bold: false, italic: true }),
    })]);
  }
  const jc = (a) => `<w:jc w:val="${a === "center" ? "center" : "left"}" />`;
  styles.push(["Title", paraStyle("Title", "Title", { custom: false, next: "BodyText", pPr: `<w:keepNext /><w:keepLines /><w:spacing w:before="0" w:after="240" />${jc(t.title.align)}`, rpr: rPr({ font: t.font, sizePt: t.title.sizePt, bold: true }) })]);
  styles.push(["Subtitle", paraStyle("Subtitle", "Subtitle", { custom: false, pPr: `<w:spacing w:before="0" w:after="120" />${jc(t.title.align)}`, rpr: plainRun })]);
  styles.push(["Author", paraStyle("Author", "Author", { next: "BodyText", pPr: `<w:keepNext /><w:spacing w:before="0" w:after="240" />${jc(t.authorAlign)}<w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["Affiliation", paraStyle("Affiliation", "Affiliation", { pPr: `<w:spacing w:before="0" w:after="120" /><w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["Correspondence", paraStyle("Correspondence", "Correspondence", { pPr: `<w:spacing w:before="0" w:after="240" /><w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["Abstract", paraStyle("Abstract", "Abstract", { next: "BodyText", pPr: `<w:spacing w:before="0" w:after="240" /><w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["AbstractTitle", paraStyle("AbstractTitle", "Abstract Title", { pPr: '<w:keepNext /><w:spacing w:before="240" w:after="60" />', rpr: rPr({ font: t.font, sizePt: t.headings[0].sizePt, bold: true }) })]);
  styles.push(["Teaser", paraStyle("Teaser", "Teaser", { pPr: `<w:spacing w:before="0" w:after="240" /><w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["SectionLabel", paraStyle("SectionLabel", "Section Label", { pPr: '<w:keepNext /><w:spacing w:before="120" w:after="120" /><w:ind w:firstLine="0" />', rpr: plainRun })]);
  styles.push(["Bibliography", paraStyle("Bibliography", "Bibliography", { custom: false, next: "Bibliography", pPr: `<w:spacing w:before="0" w:after="${t.lineSpacing >= 2 ? 0 : 60}" /><w:ind w:left="720" w:hanging="720" />`, rpr: plainRun })]);
  styles.push(["Acknowledgement", paraStyle("Acknowledgement", "Acknowledgement", { pPr: `<w:spacing w:before="0" w:after="${after * 20 || 120}" /><w:ind w:firstLine="0" />`, rpr: plainRun })]);
  styles.push(["Figure", paraStyle("Figure", "Figure", { pPr: '<w:keepNext /><w:spacing w:before="240" w:after="120" /><w:jc w:val="center" /><w:ind w:firstLine="0" />', rpr: plainRun })]);
  styles.push(["CaptionedFigure", paraStyle("CaptionedFigure", "Captioned Figure", { basedOn: "Figure", pPr: "<w:keepNext />" })]);
  styles.push(["FigureLegend", paraStyle("FigureLegend", "Figure Legend", { pPr: '<w:spacing w:before="0" w:after="240" /><w:ind w:firstLine="0" />', rpr: plainRun })]);
  styles.push(["Caption", paraStyle("Caption", "Caption", { custom: false, pPr: '<w:spacing w:before="0" w:after="120" /><w:ind w:firstLine="0" />', rpr: plainRun })]);
  styles.push(["ImageCaption", paraStyle("ImageCaption", "Image Caption", { basedOn: "Caption" })]);
  styles.push(["TableCaption", paraStyle("TableCaption", "Table Caption", { basedOn: "Caption", pPr: "<w:keepNext />" })]);
  styles.push(["Highlights", paraStyle("Highlights", "Highlights", { pPr: '<w:ind w:firstLine="0" />', rpr: plainRun })]);
  styles.push(["FootnoteText", paraStyle("FootnoteText", "Footnote Text", { custom: false, pPr: '<w:ind w:firstLine="0" />', rpr: rPr({ font: t.font, sizePt: Math.max(9, t.sizePt - 2) }) })]);
  styles.push(["Hyperlink", '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink" /><w:basedOn w:val="BodyTextChar" /><w:rPr><w:color w:val="1F4E9A" /></w:rPr></w:style>']);
  // Science's template names (paragraph styles) — same look, names Science reads.
  for (const name of t.extraStyles ?? []) {
    const defs = {
      Head: { basedOn: "Title" },
      Authors: { basedOn: "Author" },
      Affiliations: { basedOn: "Affiliation" },
      AbstractSummary: { basedOn: "Abstract" },
      Teaser: null, // defined above
      Refhead: { basedOn: "Heading1" },
      Referencesandnotes: { basedOn: "Bibliography" },
      Acknowledgement: null,
      SOMHead: { basedOn: "Heading1" },
      SOMContent: { basedOn: "Compact" },
      Legend: { basedOn: "FigureLegend" },
    }[name];
    if (defs) styles.push([name, paraStyle(name, name === "Referencesandnotes" ? "Referencesandnotes" : name, { basedOn: defs.basedOn })]);
  }
  return styles;
}

const HDR_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function footerXml() {
  // A centred PAGE field — "include page numbers in your submitted file".
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${HDR_NS}><w:p><w:pPr><w:jc w:val="center" /></w:pPr>` +
    '<w:r><w:fldChar w:fldCharType="begin" /></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate" /></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end" /></w:r>' +
    "</w:p></w:ftr>"
  );
}

function headerXml(text) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${HDR_NS}><w:p><w:pPr><w:jc w:val="left" /></w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:hdr>`;
}

function sectPr(t, refs) {
  const [w, h] = t.paper === "a4" ? [11906, 16838] : [12240, 15840];
  const m = t.margins;
  return (
    "<w:sectPr>" +
    refs.map((r) => `<w:${r.kind}Reference w:type="default" r:id="${r.id}" />`).join("") +
    `<w:pgSz w:w="${w}" w:h="${h}" />` +
    `<w:pgMar w:top="${twips(m.top)}" w:right="${twips(m.right)}" w:bottom="${twips(m.bottom)}" w:left="${twips(m.left)}" w:header="432" w:footer="720" w:gutter="0" />` +
    // countBy=1 numbers every line (Science's template: 5); restart="continuous"
    // runs straight through the manuscript rather than restarting per page,
    // which is what reviewers reference ("line 412").
    (t.lineNumbers ? `<w:lnNumType w:countBy="${t.countBy ?? 1}" w:distance="360" w:restart="continuous" />` : "") +
    "</w:sectPr>"
  );
}

const repo = path.resolve(import.meta.dirname, "..");
const outDir = path.join(repo, "resources", "docx");
mkdirSync(outDir, { recursive: true });
const only = process.argv.slice(2);

for (const t of TEMPLATES) {
  if (only.length && !only.includes(t.id)) continue;
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
    let styles = docDefaults(readFileSync(stylesPath, "utf8"), t);
    for (const [id, xml] of styleSet(t)) styles = upsertStyle(styles, id, xml);
    writeFileSync(stylesPath, styles);

    // Header/footer parts + their relationships and content types.
    const refs = [];
    const relsPath = path.join(x, "word", "_rels", "document.xml.rels");
    const ctPath = path.join(x, "[Content_Types].xml");
    let rels = readFileSync(relsPath, "utf8");
    let ct = readFileSync(ctPath, "utf8");
    const addPart = (kind, file, xml) => {
      writeFileSync(path.join(x, "word", file), xml);
      const id = `rIdFlux${kind}`;
      rels = rels.replace("</Relationships>", `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Id="${id}" Target="${file}" /></Relationships>`);
      ct = ct.replace("</Types>", `<Override PartName="/word/${file}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml" /></Types>`);
      refs.push({ kind, id });
    };
    if (t.header) addPart("header", "header1.xml", headerXml(t.header));
    if (t.pageNumbers) addPart("footer", "footer1.xml", footerXml());
    writeFileSync(relsPath, rels);
    writeFileSync(ctPath, ct);

    const docPath = path.join(x, "word", "document.xml");
    let doc = readFileSync(docPath, "utf8").replace(/<w:sectPr[\s\S]*?<\/w:sectPr>|<w:sectPr \/>/g, "");
    if (!/xmlns:r=/.test(doc)) doc = doc.replace("<w:document ", '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    doc = doc.replace("</w:body>", `${sectPr(t, refs)}</w:body>`);
    writeFileSync(docPath, doc);

    const out = path.join(outDir, `${t.id}-reference.docx`);
    rmSync(out, { force: true });
    // Zip from inside the extracted tree so paths are archive-relative; -X and a
    // fixed mtime keep the artifact reproducible run to run.
    execFileSync("find", [".", "-exec", "touch", "-t", "202601010000", "{}", "+"], { cwd: x });
    execFileSync("zip", ["-q", "-r", "-X", out, "."], { cwd: x });
    console.log(`wrote ${path.relative(repo, out)} (${t.font} ${t.sizePt}pt, ${t.lineSpacing}× spacing, line numbers: ${t.lineNumbers ? `every ${t.countBy}` : "off"}, ${t.paper})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
