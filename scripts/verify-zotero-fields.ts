#!/usr/bin/env -S npx tsx
// Live Zotero fields in an exported .docx — the contract the Word/Zotero round trip
// depends on. Every assertion here corresponds to a failure observed in Word: each one
// was a document Zotero refused, and none of them was visible to a structural check.
//   npx tsx scripts/verify-zotero-fields.ts

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import {
  markCitations,
  harvestZoteroLibrary,
  injectZoteroFields,
  parseCslIdentity,
  resolveCslIdentity,
  matchUri,
  DEFAULT_STYLE,
  type CslRecord,
  type ZoteroLibraryIndex,
} from "../src/lib/references/zoteroFields";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

const RUN = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const SUP = (t: string) => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${t}</w:t></w:r>`;

/** A minimal but structurally faithful pandoc-style .docx. */
function docx(body: string, opts: { custom?: string; footnotes?: string } = {}): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="x"></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="x"><Relationship Id="rId1"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`),
  };
  if (opts.custom) parts["docProps/custom.xml"] = strToU8(opts.custom);
  if (opts.footnotes)
    parts["word/footnotes.xml"] = strToU8(
      `<?xml version="1.0"?><w:footnotes><w:footnote w:id="2"><w:p>${opts.footnotes}</w:p></w:footnote></w:footnotes>`,
    );
  return zipSync(parts);
}
const bibParagraph = (id: number, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>` +
  `<w:bookmarkStart w:id="${id}" w:name="ref-item${id}"/>${RUN(text)}<w:bookmarkEnd w:id="${id}"/></w:p>`;

const doc = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"]);
const custom = (b: Uint8Array) => {
  const f = unzipSync(b)["docProps/custom.xml"];
  return f ? strFromU8(f) : "";
};
const payloads = (xml: string) =>
  [...xml.matchAll(/ADDIN ZOTERO_ITEM CSL_CITATION ([\s\S]*?)<\/w:instrText>/g)].map((m) =>
    JSON.parse(
      m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim(),
    ),
  );

const ITEMS: Record<string, CslRecord> = {
  bound_2005: { id: "bound_2005", title: "A bound work", DOI: "10.1/bound", issued: { "date-parts": [[2005]] } },
  loose_2000: {
    id: "loose_2000",
    title: "An unbound work",
    DOI: "10.1/loose",
    issued: { "date-parts": [[2000]] },
    keyword: "tags, pandoc, adds",
  },
};
const INDEX: ZoteroLibraryIndex = {
  items: {
    "http://zotero.org/users/999/items/ABCD1234": {
      uri: "http://zotero.org/users/999/items/ABCD1234",
      library: "999",
      itemData: { id: 7462, title: "A bound work", DOI: "10.1/bound", issued: { "date-parts": [["2005"]] } },
    },
  },
  byDoi: { "10.1/bound": "http://zotero.org/users/999/items/ABCD1234" },
  byTitle: { aboundwork: "http://zotero.org/users/999/items/ABCD1234" },
  libraries: ["999"],
  sources: [],
};

// ---- marking ---------------------------------------------------------------
{
  const out = markCitations("See @fig-1 and [@a_2020; @b_2019] plus @c_2021.\n\n```\n@not_a_cite\n```\n");
  assert(!out.includes("⟦ZC{fig-1}"), "crossrefs (@fig-) are not marked");
  assert(out.includes("⟦ZC{a_2020,b_2019}⟧"), "a bracketed group is ONE marker carrying both keys, in order");
  assert(out.includes("⟦ZC{c_2021}⟧"), "a bare @key is marked");
  assert(!out.includes("⟦ZC{not_a_cite}"), "fenced code is left alone");
  assert(markCitations("no citations here") === "no citations here", "a document without citations is untouched");
}

// ---- marking respects bracket CONTEXT --------------------------------------
// Markdown reuses `[…]` for constructs that live or die on adjacency. Group-marking one
// of those splits it apart — an inline footnote became a literal `^` in the prose with
// its text inlined, and a figure embed whose caption cited collapsed to text.
{
  const fn = markCitations("A note.^[Discussed by @a_2020.] More.");
  assert(fn.includes(".^[Discussed by "), "an inline footnote keeps its ^[ adjacency — never split by a marker");
  assert(!fn.includes("⟦ZC"), "…and its interior is NOT marked (footnote citations stay citeproc text)");

  // The export prep folds figure captions into the alt slot, so a caption's citation
  // sits inside `![…](…)` at marking time. The embed must survive; the citation inside
  // it becomes a live field in the caption paragraph.
  const img = markCitations("![**Fig. 1 |** As shown by @a_2020.](fig/renders/x.svg){#x-fig-x}");
  assert(img.startsWith("![**Fig. 1 |** "), "an image keeps its ![ adjacency");
  assert(img.includes("](fig/renders/x.svg){#x-fig-x}"), "…and its ](target){attrs} tail");
  assert(img.includes("⟦ZC{a_2020}⟧"), "…while the caption's citation IS marked, inside the alt");

  const link = markCitations("See [the review by @a_2020](https://x.test) here.");
  assert(link === "See [the review by @a_2020](https://x.test) here.",
    "a link is left whole — a field inside a hyperlink is not a proven-safe document");
  const reflink = markCitations("See [the review by @a_2020][rev] here.");
  assert(!reflink.includes("⟦"), "a reference link is left whole");
  const span = markCitations("See [text with @a_2020]{.smallcaps} here.");
  assert(!span.includes("⟦"), "an attributed span is left whole");

  // A `!` that is prose punctuation, not an image (no target follows): the bracket is
  // still a citation group — which renders identically, since pandoc also reads it as
  // literal `!` + citation there.
  const bang = markCitations("Amazing![@a_2020] indeed.");
  assert(bang.includes("⟦ZC{a_2020}⟧"), "prose `!` before a bare group does not suppress marking");
}

// ---- the uris rule (the defect that cost the most) --------------------------
{
  const body = `<w:p>${RUN("⟦ZC{loose_2000}⟧")}${RUN("(Loose, 2000)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "Loose 2000");
  const { bytes, report } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa" });
  const items = payloads(doc(bytes)).flatMap((p) => p.citationItems);
  assert(report.embedded === 1 && report.bound === 0, "an item with no library match is embedded");
  assert(
    items.every((i: { uris?: string[] }) => Array.isArray(i.uris) && i.uris.length > 0),
    "EVERY citation item carries uris — Zotero refuses a document where one does not",
  );
  assert(
    items[0].uris[0].includes("/users/local/"),
    "an unmatched item gets the local-library form, which cannot bind to anyone's library",
  );
  assert(typeof items[0].id === "number", "ids are numeric, as Zotero writes them");
  assert(!("keyword" in items[0].itemData), "pandoc's keyword blob is dropped");
  assert(
    items[0].itemData.issued["date-parts"][0][0] === "2000",
    "date-parts are strings in the records we synthesise",
  );
}

// ---- escaping: raw double quotes -------------------------------------------
{
  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(Bound, 2005)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "Bound 2005");
  const { bytes } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa", index: INDEX });
  const xml = doc(bytes);
  const instr = [...xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]).join("");
  assert(!instr.includes("&quot;"), "field instructions carry RAW double quotes — &quot; makes Zotero fail to parse");
  assert(instr.includes('"citationID"'), "the payload is readable as JSON in the instruction text");
  assert(!custom(bytes).includes("&quot;"), "the preferences blob likewise keeps raw quotes");
}

// ---- binding ---------------------------------------------------------------
{
  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(Bound, 2005)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "Bound 2005");
  const { bytes, report } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa", index: INDEX });
  const item = payloads(doc(bytes))[0].citationItems[0];
  assert(report.bound === 1, "a DOI match binds to the harvested library");
  assert(item.uris[0] === "http://zotero.org/users/999/items/ABCD1234", "the citation carries THAT library's URI");
  assert(item.itemData.id === 7462, "the harvested record is used verbatim, ids included");
  const noYear = matchUri({ id: "x", title: "A bound work", issued: { "date-parts": [[1999]] } }, INDEX);
  assert(noYear === null, "a title match with a disagreeing year is refused — a wrong URI is worse than none");
  const noEvidence = matchUri({ id: "x", title: "Something else entirely" }, INDEX);
  assert(noEvidence === null, "author+year alone is not evidence of identity (it produced a false positive)");
}

// ---- bibliography field + pandoc's anchors ---------------------------------
{
  const body =
    `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(Bound, 2005)")}${RUN("⟦ZE⟧")}</w:p>` +
    bibParagraph(1, "Bound 2005") +
    bibParagraph(2, "Loose 2000");
  const { bytes, report } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa", index: INDEX });
  const xml = doc(bytes);
  assert(report.bibliographyEntries === 2, "every bibliography paragraph is inside the field");
  assert(xml.includes("ADDIN ZOTERO_BIBL"), "the reference list is wrapped, so refreshing regenerates it");
  assert(report.bookmarksRemoved === 2, "pandoc's ref-* anchors are removed from the field region");
  assert(!/<w:bookmark(Start|End)[^>]*w:id="[12]"/.test(xml), "…and no half of a pair is left dangling");
  const begins = (xml.match(/fldCharType="begin"/g) ?? []).length;
  const ends = (xml.match(/fldCharType="end"/g) ?? []).length;
  assert(begins === ends && begins === 2, "field triples balance: one citation + one bibliography");
}

// ---- superscript spacing ----------------------------------------------------
{
  const body =
    `<w:p>${RUN("Text")}${RUN(" ")}${RUN("⟦ZC{bound_2005}⟧")}${SUP("1")}${RUN("⟦ZE⟧")}</w:p>` +
    bibParagraph(1, "Bound 2005");
  const { bytes, report } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/n", index: INDEX });
  assert(report.spacesReclaimed === 1, "the space citeproc would have eaten before a superscript is reclaimed");
  assert(!doc(bytes).includes(`${RUN("Text")}${RUN(" ")}<w:r><w:fldChar`), "…so the text matches an ordinary render");
}

// ---- footnote citations: demoted to displayed text, never marker garbage ----
// Citations reach word/footnotes.xml from `[^1]:` definitions. A Word field there is
// untested against real Zotero, and the injector once processed only document.xml — so
// the markers shipped VISIBLY in the reader's footnote. They demote to citeproc's text.
{
  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(Bound, 2005)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "b");
  const footnotes = `${RUN("Discussed by ")}${RUN("⟦ZC{loose_2000}⟧")}${RUN("Loose (2000)")}${RUN("⟦ZE⟧")}${RUN(".")}`;
  const { bytes, report } = injectZoteroFields(docx(body, { footnotes }), {
    items: ITEMS,
    styleId: "http://x/apa",
    index: INDEX,
  });
  const fnXml = strFromU8(unzipSync(bytes)["word/footnotes.xml"]);
  assert(!fnXml.includes("⟦"), "no marker survives into footnotes.xml");
  assert(fnXml.includes("Loose (2000)"), "the footnote citation keeps its displayed text");
  assert(!fnXml.includes("ADDIN"), "…as plain text, not a field (untested against real Zotero — deliberate)");
  assert(report.notesPlain === 1, "the demotion is reported (notesPlain)");
  assert(report.citations === 1, "body citations still become fields alongside a footnote demotion");
}

// ---- markers never survive; unresolved citations stay text ------------------
{
  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(Bound, 2005)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "b");
  const { bytes } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa", index: INDEX });
  assert(!doc(bytes).includes("⟦"), "no marker survives into the output");

  const unknown = `<w:p>${RUN("⟦ZC{nowhere_1999}⟧")}${RUN("(Nowhere)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "b");
  const r2 = injectZoteroFields(docx(unknown), { items: ITEMS, styleId: "http://x/apa" });
  assert(r2.report.skipped === 1 && !doc(r2.bytes).includes("ADDIN ZOTERO_ITEM"), "a citation with no record stays plain text");
  assert(doc(r2.bytes).includes("(Nowhere)"), "…and its displayed text is preserved");

  let threw = false;
  try {
    injectZoteroFields(docx(`<w:p>${RUN("no markers")}</w:p>`), { items: ITEMS, styleId: "http://x/apa" });
  } catch {
    threw = true;
  }
  assert(threw, "a document rendered without citation marking is refused rather than silently unchanged");
}

// ---- preferences ------------------------------------------------------------
{
  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(B)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "b");
  const existing =
    '<?xml version="1.0"?><Properties xmlns="x" xmlns:vt="y">' +
    '<property fmtid="{F}" pid="2" name="biblio-config"><vt:lpwstr>True</vt:lpwstr></property></Properties>';
  const { bytes } = injectZoteroFields(docx(body, { custom: existing }), {
    items: ITEMS,
    styleId: "http://www.zotero.org/styles/apa",
    locale: "en-GB",
    index: INDEX,
  });
  const cx = custom(bytes);
  assert(cx.includes('name="biblio-config"'), "existing custom properties survive — the part is merged, not replaced");
  assert(cx.includes('name="ZOTERO_PREF_1"'), "the Zotero preferences are written");
  assert(/pid="3"/.test(cx), "…with pids continuing from the highest already present");
  assert(cx.includes('locale="en-GB"'), "the locale comes from the caller's CSL identity");
  const parts = [...cx.matchAll(/name="ZOTERO_PREF_\d+"><vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/g)].map((m) => m[1]);
  const blob = parts.join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert(blob.startsWith("<data") && blob.endsWith("</data>"), "the split parts reassemble into the prefs blob");
  assert(blob.includes('fieldType" value="Field'), "fieldType is Field (Word fields, not bookmarks)");
}

// ---- CSL identity + harvesting round trip -----------------------------------
{
  const csl = '<style xmlns="x" default-locale="en-GB"><info><id>http://www.zotero.org/styles/nature</id></info></style>';
  const id = parseCslIdentity(csl);
  assert(id?.styleId === "http://www.zotero.org/styles/nature" && id.locale === "en-GB", "style id + locale come from the CSL");
  assert(parseCslIdentity("<style/>") === null, "a CSL without an <id> yields no identity");

  const body = `<w:p>${RUN("⟦ZC{bound_2005}⟧")}${RUN("(B)")}${RUN("⟦ZE⟧")}</w:p>` + bibParagraph(1, "b");
  const { bytes } = injectZoteroFields(docx(body), { items: ITEMS, styleId: "http://x/apa", index: INDEX });
  const back = harvestZoteroLibrary([{ name: "ours.docx", bytes }]);
  assert(
    back.items["http://zotero.org/users/999/items/ABCD1234"]?.itemData.title === "A bound work",
    "a document we wrote can be harvested back — emit and harvest agree on the format",
  );
  assert(back.libraries.join() === "999", "the harvested library is identified");
  assert(harvestZoteroLibrary([{ name: "junk.docx", bytes: strToU8("not a zip") }]).sources[0].items === 0,
    "an unreadable file yields no items rather than throwing");
}

// ---- resolveCslIdentity: ONE precedence for both engines --------------------
// The GUI once carried its own copy of this walk, which skipped the front-matter
// candidates entirely — a hand-declared `csl:` got the right style from the CLI and
// Chicago from the app. The precedence is pinned here so it cannot fork again.
{
  const CSL = (id: string) => `<style xmlns="x"><info><id>${id}</id></info></style>`;
  const files: Record<string, string> = {
    "/p/references/styles/nature.csl": CSL("http://z/nature"),
    "/p/manuscript/main.qmd": '---\ntitle: t\ncsl: my/apa.csl\n---\nBody text.',
    "/p/manuscript/my/apa.csl": CSL("http://z/apa"),
    "/p/manuscript/_quarto.yml": 'project:\n  type: default\n  csl: also.csl\n',
    "/p/manuscript/also.csl": CSL("http://z/yml"),
  };
  const rd = async (p: string) => files[p] ?? null;
  const at = { root: "/p", docPath: "/p/manuscript/main.qmd" };

  const styled = await resolveCslIdentity(rd, { ...at, styleCsl: "references/styles/nature.csl" });
  assert(styled.styleId === "http://z/nature", "the journal style's CSL asset wins when present");
  const fromDoc = await resolveCslIdentity(rd, at);
  assert(fromDoc.styleId === "http://z/apa", "no style asset → the document's own csl: front matter, doc-relative");
  const fromYml = await resolveCslIdentity(rd, { root: "/p", docPath: "/p/manuscript/other.qmd" });
  assert(fromYml.styleId === "http://z/yml", "no front matter → the directory's _quarto.yml csl");
  const noneAtAll = await resolveCslIdentity(async () => null, at);
  assert(noneAtAll.styleId === DEFAULT_STYLE.styleId, "nothing anywhere → pandoc's own default");
  const unreadable = await resolveCslIdentity(
    async (p) => (p.endsWith("nature.csl") ? null : files[p] ?? null),
    { ...at, styleCsl: "references/styles/nature.csl" },
  );
  assert(unreadable.styleId === "http://z/apa", "an unreadable candidate falls through to the next");
  const noId = await resolveCslIdentity(
    async (p) => (p.endsWith("nature.csl") ? "<style/>" : files[p] ?? null),
    { ...at, styleCsl: "references/styles/nature.csl" },
  );
  assert(noId.styleId === "http://z/apa", "a CSL without an <id> is skipped, not trusted");
}

console.log(failures ? `\nZOTERO-FIELDS: FAIL (${failures})` : "\nZOTERO-FIELDS: PASS");
process.exit(failures ? 1 : 0);
