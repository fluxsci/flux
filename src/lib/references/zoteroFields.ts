// src/lib/references/zoteroFields.ts — live Zotero fields in an exported .docx.
//
// Pandoc/Quarto resolve `[@key]` through citeproc, which bakes the formatted citation
// into ordinary text runs. The item identity is gone, so a Word user receiving the file
// cannot refresh, renumber, restyle, or add a citation beside ours — and pandoc's docx
// READER discards `ADDIN` instructions in the other direction, so a round trip through
// Flux destroys the identities a Zotero user had. This module restores them, writing the
// same Word fields Zotero's own plugin writes.
//
// SHARED CORE (twin-engine rule): pure, no fs and no DOM. Both callers hand it bytes and
// get bytes back — flux-core's `compile` (Node) and the in-app Word export (renderer, via
// FileBridge readFile/writeFile). fflate is pure JS, so it loads in both worlds.
//
// The full derivation, including the traps that are not documented anywhere else, is
// specified in the project this came from; the load-bearing rules are restated here.

import { unzipSync, zipSync } from "fflate";

/** Citation markers. PRINTABLE on purpose: a marker that ever survives into an exported
 *  document is then plainly visible, where an invisible control character would be silent
 *  damage in a manuscript. `⟦` does not occur in ordinary scientific prose. */
export const MARK_OPEN = (keys: string) => `⟦ZC{${keys}}⟧`;
export const MARK_CLOSE = "⟦ZE⟧";
const MARK_PREFIX = "⟦Z";
const OPEN_RUN = new RegExp(
  `<w:r><w:t xml:space="preserve">⟦ZC\\{([^}]*)\\}⟧</w:t></w:r>([\\s\\S]*?)` +
    `<w:r><w:t xml:space="preserve">⟦ZE⟧</w:t></w:r>`,
  "g",
);
const SPACE_RUN = '<w:r><w:t xml:space="preserve"> </w:t></w:r>';
/** Unescaped characters per ZOTERO_PREF_n property. */
const PREF_CHUNK = 255;

export interface CslRecord {
  id: string | number;
  title?: string;
  DOI?: string;
  issued?: { "date-parts"?: (string | number)[][] };
  [k: string]: unknown;
}
export interface HarvestedItem {
  uri: string;
  library: string | null;
  itemData: CslRecord;
}
export interface ZoteroLibraryIndex {
  items: Record<string, HarvestedItem>;
  byDoi: Record<string, string>;
  byTitle: Record<string, string>;
  libraries: string[];
  sources: { name: string; items: number }[];
}
export interface InjectOptions {
  /** Every cited record, keyed by citekey. */
  items: Record<string, CslRecord>;
  /** Zotero style id, e.g. http://www.zotero.org/styles/apa — read from the CSL file. */
  styleId: string;
  locale?: string;
  /** Optional harvested libraries; citations that match one are bound to it. */
  index?: ZoteroLibraryIndex | null;
  /** Stable per document, so re-running produces an identical file. */
  sessionId?: string;
  zoteroVersion?: string;
}
export interface InjectReport {
  citations: number;
  bound: number;
  embedded: number;
  /** Citations whose keys resolved to no record; left as plain text. */
  skipped: number;
  /** Citations rendered into footnotes/endnotes — demoted to their displayed text.
   *  Word fields there are untested against real Zotero, so they are deliberately
   *  not written (a follow-up needs its own Word round trip). */
  notesPlain: number;
  missingFromItems: string[];
  bibliographyEntries: number;
  bookmarksRemoved: number;
  spacesReclaimed: number;
}

const emptyIndex = (): ZoteroLibraryIndex => ({
  items: {},
  byDoi: {},
  byTitle: {},
  libraries: [],
  sources: [],
});

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

/** Escape for XML text content — and NOT the double quote.
 *
 *  Zotero writes its field instructions and its preference blob with RAW double quotes,
 *  escaping only & < >. Escaping the quote as &quot; is well-formed XML, but Word hands
 *  the field code back to Zotero undecoded, so Zotero sees {&quot;citationID&quot;:…},
 *  cannot parse it, and refresh fails. The same mistake in the preferences is quieter:
 *  the style silently falls back to Zotero's default. */
function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function xmlUnescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Fold a title (or name) to a comparison key: no accents, case or punctuation. */
export function foldKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** A short stable hex digest — deterministic ids without a crypto dependency. */
function digest(input: string, length: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, length);
}

// ---------------------------------------------------------------- harvesting

/** All field-instruction text of a document, in order.
 *
 *  Word may split one field's instruction across several runs, so the pieces are joined;
 *  NUL marks where a boundary fell so a brace scan can ignore it. */
function instructionText(documentXml: string): string {
  const pieces: string[] = [];
  for (const m of documentXml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)) pieces.push(m[1]);
  return pieces.join("\0");
}

/** The JSON object starting at `start`, by brace matching outside strings. */
function scanJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Read the Zotero item identities out of .docx files that already use Zotero.
 *
 *  This is what makes "link to a known library" possible: given documents the recipient
 *  wrote through Zotero's Word plugin, every cited item's library URI and CSL record can
 *  be recovered and matched against our own references. Later files win on collision. */
export function harvestZoteroLibrary(files: { name: string; bytes: Uint8Array }[]): ZoteroLibraryIndex {
  const index = emptyIndex();
  for (const file of files) {
    let documentXml = "";
    try {
      documentXml = decode(unzipSync(file.bytes)["word/document.xml"]);
    } catch {
      index.sources.push({ name: file.name, items: 0 });
      continue;
    }
    const joined = xmlUnescape(instructionText(documentXml));
    let found = 0;
    for (const m of joined.matchAll(/ADDIN ZOTERO_ITEM CSL_CITATION/g)) {
      const brace = joined.indexOf("{", (m.index ?? 0) + m[0].length);
      if (brace < 0) continue;
      const raw = scanJsonObject(joined, brace);
      if (!raw) continue;
      let payload: { citationItems?: { uris?: string[]; itemData?: CslRecord }[] };
      try {
        payload = JSON.parse(raw.replace(/\0/g, ""));
      } catch {
        continue;
      }
      for (const item of payload.citationItems ?? []) {
        const uri = item.uris?.[0];
        const data = item.itemData;
        if (!uri || !data) continue;
        found++;
        const library = /zotero\.org\/(?:users|groups)\/([^/]+)\//.exec(uri)?.[1] ?? null;
        index.items[uri] = { uri, library, itemData: data };
        const doi = String(data.DOI ?? "").trim().toLowerCase();
        if (doi) index.byDoi[doi] = uri;
        if (data.title) index.byTitle[foldKey(String(data.title))] = uri;
      }
    }
    index.sources.push({ name: file.name, items: found });
  }
  index.libraries = [...new Set(Object.values(index.items).map((i) => i.library).filter(Boolean) as string[])].sort();
  return index;
}

/** How many of `keys` this index can bind — for the dialog's "n of m matched". */
export function countMatches(keys: string[], items: Record<string, CslRecord>, index: ZoteroLibraryIndex | null): number {
  if (!index) return 0;
  return keys.filter((k) => items[k] && matchUri(items[k], index)).length;
}

/** Find a record in a harvested library.
 *
 *  Evidence accepted: DOI, then folded title WITH an agreeing year. First-author+year was
 *  implemented and removed — a leave-one-out control caught it binding one work to a
 *  different work by the same author in the same year. A wrong URI silently attaches a
 *  citation to the wrong reference in someone's library, which is worse than no link. */
export function matchUri(record: CslRecord, index: ZoteroLibraryIndex): string | null {
  const doi = String(record.DOI ?? "").trim().toLowerCase();
  if (doi && index.byDoi[doi]) return index.byDoi[doi];
  const title = record.title ? foldKey(String(record.title)) : "";
  if (title && index.byTitle[title]) {
    const uri = index.byTitle[title];
    const ours = record.issued?.["date-parts"]?.[0]?.[0];
    const theirs = index.items[uri]?.itemData?.issued?.["date-parts"]?.[0]?.[0];
    if (ours != null && theirs != null && String(ours) === String(theirs)) return uri;
  }
  return null;
}

/** The Zotero style id + locale carried by a CSL file's own <info> block.
 *
 *  Reading it from the CSL actually used means the citations Word displays and the style
 *  Zotero would reformat to cannot disagree — a mismatched pair is unrepresentable. */
export function parseCslIdentity(cslText: string): { styleId: string; locale: string } | null {
  const id = /<id>([^<]+)<\/id>/.exec(cslText)?.[1];
  if (!id) return null;
  return { styleId: id, locale: /default-locale="([^"]+)"/.exec(cslText)?.[1] ?? "en-US" };
}

/** Pandoc's own default when a document configures no CSL at all. */
export const DEFAULT_STYLE = { styleId: "http://www.zotero.org/styles/chicago-author-date", locale: "en-US" };

// ---------------------------------------------------------------- marking

/** Quarto crossref namespaces — `@fig-3`, `@tbl-1` are references, not citations. */
const CROSSREF = /^(fig|tbl|sec|eq|lst|thm|lem|cor|prp|cnj|def|exm|exr|nte|wrn|imp|tip|cau|sol|rem|vid|alg|supp)-/;
const CITEKEY = /@([A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_]|[A-Za-z0-9_])/g;
const rawRun = (text: string) =>
  "`<w:r><w:t xml:space=\"preserve\">" + text + "</w:t></w:r>`{=openxml}";

function keysIn(fragment: string): string[] {
  const keys: string[] = [];
  for (const m of fragment.matchAll(CITEKEY)) if (!CROSSREF.test(m[1])) keys.push(m[1]);
  return keys;
}

/** Mark every bare `@key` in `piece` individually. */
function markBareKeys(piece: string): string {
  return piece.replace(CITEKEY, (whole, key: string) =>
    CROSSREF.test(key) ? whole : rawRun(MARK_OPEN(key)) + whole + rawRun(MARK_CLOSE),
  );
}

/** Bracket each citation with markers naming its citekeys, in source order.
 *
 *  A rendered citation's text ("[12,13]") does not identify its items, and matching it
 *  back against the bibliography is ambiguous — so the citations are marked BEFORE Quarto
 *  runs, and the post-processor reads the markers. They are emitted as raw openxml, so
 *  each becomes its own run whatever pandoc does with the surrounding text.
 *
 *  A bracket containing `@` is a CITATION GROUP only in citation position. Markdown
 *  reuses the same bracket for constructs that live or die on ADJACENCY, and marking
 *  around those splits them apart (a literal `^` in the prose where a footnote was, a
 *  figure embed collapsing to text — both shipped before this was context-checked):
 *    - `^[…]` is an inline footnote — left whole, citations included: footnote content
 *      renders into word/footnotes.xml, where fields are deliberately not written. A
 *      `[^1]:` definition is ordinary text to this pass, so ITS citations do get
 *      marked — the injector demotes those back to displayed text (demoteMarkedCitations).
 *    - `![…](…)` is an image; the export prep folds figure captions into that alt slot,
 *      so its INTERIOR is bare-marked — a caption's citation becomes a live field in
 *      the caption paragraph while the embed itself stays an embed.
 *    - `[…](…)` / `[…][…]` / `[…]{…}` are links/spans — left whole; their citations
 *      stay baked text, because a Word field inside a hyperlink is not a document
 *      Zotero has been proven to accept.
 *
 *  Applied to the export copy only; the prep restores the sources afterwards. */
export function markCitations(text: string): string {
  // Never touch code (fenced or inline) or the YAML header.
  const parts = text.split(/(^---\n[\s\S]*?\n---\n|```[\s\S]*?```|`[^`\n]*`)/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // a delimiter capture: header, fence or code span
      // Bracketed groups first: `[@a; @b]` is ONE citation carrying two keys.
      const pieces = part.split(/(\[[^\]]*@[^\]]*\])/g);
      return pieces
        .map((piece, j) => {
          const keys = keysIn(piece);
          if (!keys.length) return piece;
          if (j % 2 === 1) {
            const prev = pieces[j - 1] ?? "";
            const next = pieces[j + 1] ?? "";
            if (prev.endsWith("^")) return piece; // inline footnote — leave whole
            if (prev.endsWith("!") && next.startsWith("(")) return markBareKeys(piece); // image alt
            if (/^[([{]/.test(next)) return piece; // link / reference link / span
            return rawRun(MARK_OPEN(keys.join(","))) + piece + rawRun(MARK_CLOSE);
          }
          // Bare `@key` citations, one marker each.
          return markBareKeys(piece);
        })
        .join("");
    })
    .join("");
}

// ---------------------------------------------------------------- emitting

/** Coerce a record into the shape Zotero writes: string date-parts, no `keyword`. */
function zoteroShape(record: CslRecord): CslRecord {
  const out: CslRecord = { ...record };
  delete out.keyword;
  for (const field of ["issued", "accessed", "submitted", "original-date"]) {
    const value = out[field] as { "date-parts"?: (string | number)[][] } | undefined;
    if (value?.["date-parts"]) {
      out[field] = {
        ...value,
        "date-parts": value["date-parts"].map((group) => group.map((part) => String(part))),
      };
    }
  }
  return out;
}

/** A URI for an item that is in no known library.
 *
 *  Every citation item Zotero writes carries `uris`; one without it is unlike anything
 *  Zotero produces and it REFUSES the document — refresh fails immediately. So an unbound
 *  item gets Zotero's local-library form. This cannot mis-bind: a recipient's local key
 *  differs, so the URI matches nothing in their library and the item stays embedded,
 *  which is the meaning intended. */
function localUri(library: string, citekey: string): string {
  return `http://zotero.org/users/local/${library}/items/${digest(citekey, 8).toUpperCase()}`;
}

function buildPayload(
  keys: string[],
  displayed: string,
  ordinal: number,
  opts: Required<Pick<InjectOptions, "items">> & { index: ZoteroLibraryIndex | null; library: string },
  report: InjectReport,
): { json: string; resolved: boolean } {
  const citationItems: Record<string, unknown>[] = [];
  for (const key of keys) {
    const record = opts.items[key];
    if (!record) {
      report.missingFromItems.push(key);
      continue;
    }
    const uri = opts.index ? matchUri(record, opts.index) : null;
    if (uri) {
      const harvested = opts.index!.items[uri];
      citationItems.push({ id: harvested.itemData.id ?? key, uris: [uri], itemData: harvested.itemData });
      report.bound++;
    } else {
      const numericId = 1_000_000 + (parseInt(digest(key, 6), 16) % 900_000);
      const data = zoteroShape(record);
      data.id = numericId;
      citationItems.push({ id: numericId, uris: [localUri(opts.library, key)], itemData: data });
      report.embedded++;
    }
  }
  return {
    json: JSON.stringify({
      citationID: "f" + digest(`${ordinal}:${keys.join(",")}`, 10),
      properties: { unsorted: false, formattedCitation: displayed, plainCitation: displayed, noteIndex: 0 },
      citationItems,
      schema: "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
    }),
    resolved: citationItems.length > 0,
  };
}

/** A Word field: begin, instruction, separate, the displayed result, end. */
function fieldRuns(instruction: string, displayedRuns: string): string {
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${xmlEscape(instruction)} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    displayedRuns +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

function wrapCitations(
  documentXml: string,
  opts: Required<Pick<InjectOptions, "items">> & { index: ZoteroLibraryIndex | null; library: string },
  report: InjectReport,
): string {
  const out: string[] = [];
  let cursor = 0;
  let ordinal = 0;
  OPEN_RUN.lastIndex = 0;
  for (const m of documentXml.matchAll(OPEN_RUN)) {
    const at = m.index ?? 0;
    const keys = m[1].split(",").filter(Boolean);
    const middle = m[2];
    const displayed = xmlUnescape([...middle.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(""));
    ordinal++;
    const { json, resolved } = buildPayload(keys, displayed, ordinal, opts, report);
    let preceding = documentXml.slice(cursor, at);
    if (!resolved) {
      // Nothing resolved — emit the text unchanged rather than an empty field. Second
      // line of defence behind the caller's cross-reference filtering.
      report.skipped++;
      out.push(preceding, middle);
      cursor = at + m[0].length;
      continue;
    }
    report.citations++;
    // Citeproc deletes the space before a SUPERSCRIPT citation, but only while the Space
    // and the Cite are adjacent inlines — which the sentinels separate. Restore it, or
    // the document differs from an ordinary render by one character per citation.
    if (middle.includes('w:vertAlign w:val="superscript"') && preceding.endsWith(SPACE_RUN)) {
      preceding = preceding.slice(0, -SPACE_RUN.length);
      report.spacesReclaimed++;
    }
    out.push(preceding, fieldRuns(`ADDIN ZOTERO_ITEM CSL_CITATION ${json}`, middle));
    cursor = at + m[0].length;
  }
  out.push(documentXml.slice(cursor));
  return out.join("");
}

/** Demote every marked citation in a notes part (footnotes/endnotes) to its displayed
 *  text. Citations reach these parts from `[^1]:` definitions and inline footnotes; a
 *  live field there is untested against real Word/Zotero, and the alternative — leaving
 *  the markers — ships visible `⟦ZC…⟧` garbage in the reader's footnote. */
function demoteMarkedCitations(xml: string, report: InjectReport): string {
  return xml.replace(OPEN_RUN, (_whole, _keys, middle: string) => {
    report.notesPlain++;
    return middle;
  });
}

const BIB_PARA = /<w:p>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g;
const isBibliography = (p: string) => p.includes('w:pStyle w:val="Bibliography"');

function wrapBibliography(documentXml: string, report: InjectReport): string {
  let paragraphs = [...documentXml.matchAll(BIB_PARA)].filter((m) => isBibliography(m[0]));
  if (!paragraphs.length) return documentXml;

  // Pandoc writes a `ref-*` bookmark around every entry, so the field would enclose all
  // of them — and the first entry's anchor straddles the boundary, its start outside and
  // its end inside. Zotero replaces the whole field content when it regenerates, and a
  // dangling bookmark pair there is fatal. Nothing points at these anchors (the citations
  // are fields, not internal links), and Zotero's own documents carry none here.
  const region = documentXml.slice(paragraphs[0].index ?? 0, (paragraphs[paragraphs.length - 1].index ?? 0) + paragraphs[paragraphs.length - 1][0].length);
  const refIds = new Set<string>();
  for (const m of region.matchAll(/<w:bookmarkStart[^>]*w:id="(\d+)"[^>]*w:name="([^"]*)"/g)) {
    if (m[2].startsWith("ref")) refIds.add(m[1]);
  }
  for (const m of region.matchAll(/<w:bookmarkEnd[^>]*w:id="(\d+)"/g)) {
    if (refIds.has(m[1])) continue;
    const start = new RegExp(`<w:bookmarkStart[^>]*w:id="${m[1]}"[^>]*w:name="([^"]*)"`).exec(documentXml);
    if (start && start[1].startsWith("ref")) refIds.add(m[1]);
  }
  if (refIds.size) {
    const ids = [...refIds].join("|");
    documentXml = documentXml.replace(new RegExp(`<w:bookmark(?:Start|End)[^>]*w:id="(?:${ids})"[^>]*/>`, "g"), "");
    report.bookmarksRemoved = refIds.size;
    paragraphs = [...documentXml.matchAll(BIB_PARA)].filter((m) => isBibliography(m[0]));
  }

  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  const instruction = 'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY';
  const opener =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve"> ${xmlEscape(instruction)} </w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  const closer = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';

  // The field spans paragraphs: it opens inside the first entry and closes in the last.
  const head = first[0];
  const pprEnd = /^<w:p>(<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(head);
  const cut = pprEnd ? pprEnd[0].length : "<w:p>".length;
  const newFirst = head.slice(0, cut) + opener + head.slice(cut);
  report.bibliographyEntries = paragraphs.length;

  if (first === last) {
    const one = newFirst.slice(0, -"</w:p>".length) + closer + "</w:p>";
    return documentXml.slice(0, first.index) + one + documentXml.slice((first.index ?? 0) + head.length);
  }
  const newLast = last[0].slice(0, -"</w:p>".length) + closer + "</w:p>";
  return (
    documentXml.slice(0, first.index) +
    newFirst +
    documentXml.slice((first.index ?? 0) + head.length, last.index) +
    newLast +
    documentXml.slice((last.index ?? 0) + last[0].length)
  );
}

/** docProps/custom.xml carrying ZOTERO_PREF_n, MERGED into existing properties.
 *
 *  The rendered document already has custom properties of its own (Quarto writes
 *  biblio-config among others), so this part is extended, never replaced. The blob is
 *  split at 255 UNESCAPED characters per part and each part escaped afterwards —
 *  splitting the escaped text would put the boundary in the wrong place and Zotero would
 *  fail to reassemble it. */
function customProperties(blob: string, existing: string | null): string {
  const parts: string[] = [];
  for (let i = 0; i < blob.length; i += PREF_CHUNK) parts.push(blob.slice(i, i + PREF_CHUNK));

  let kept = "";
  let nextPid = 2;
  if (existing) {
    kept = [...existing.matchAll(/<property\b(?:(?!<\/property>)[\s\S])*<\/property>/g)]
      .map((m) => m[0])
      .filter((p) => !p.includes("ZOTERO_PREF_"))
      .join("");
    const pids = [...kept.matchAll(/pid="(\d+)"/g)].map((m) => Number(m[1]));
    nextPid = pids.length ? Math.max(...pids) + 1 : 2;
  }
  const props = parts
    .map(
      (part, i) =>
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${nextPid + i}" ` +
        `name="ZOTERO_PREF_${i + 1}"><vt:lpwstr>${xmlEscape(part)}</vt:lpwstr></property>`,
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    kept +
    props +
    "</Properties>"
  );
}

/** Rewrite a rendered .docx so its citations and reference list are live Zotero fields.
 *
 *  The document must have been rendered with citation sentinels (see markCitations in
 *  exportPrep) — without them there is nothing to identify each rendered citation. */
export function injectZoteroFields(
  docxBytes: Uint8Array,
  opts: InjectOptions,
): { bytes: Uint8Array; report: InjectReport } {
  const report: InjectReport = {
    citations: 0,
    bound: 0,
    embedded: 0,
    skipped: 0,
    notesPlain: 0,
    missingFromItems: [],
    bibliographyEntries: 0,
    bookmarksRemoved: 0,
    spacesReclaimed: 0,
  };
  const parts = unzipSync(docxBytes);
  let documentXml = decode(parts["word/document.xml"]);
  if (!documentXml.includes(MARK_PREFIX)) {
    throw new Error("no citation sentinels found — render with citation marking enabled first");
  }

  const session = opts.sessionId ?? digest(opts.styleId, 8).toUpperCase();
  documentXml = wrapCitations(
    documentXml,
    { items: opts.items, index: opts.index ?? null, library: session.toLowerCase() },
    report,
  );
  documentXml = wrapBibliography(documentXml, report);
  if (documentXml.includes(MARK_PREFIX)) throw new Error("citation markers survived — refusing to write");

  // Footnote/endnote citations demote to their displayed text (see demoteMarkedCitations).
  // The survival check runs on these parts too: a marker anywhere is refuse-to-write,
  // never something the reader sees.
  for (const name of ["word/footnotes.xml", "word/endnotes.xml"]) {
    if (!parts[name]) continue;
    let xml = decode(parts[name]);
    if (!xml.includes(MARK_PREFIX)) continue;
    xml = demoteMarkedCitations(xml, report);
    if (xml.includes(MARK_PREFIX)) throw new Error("citation markers survived — refusing to write");
    parts[name] = encode(xml);
  }

  const blob =
    `<data data-version="3" zotero-version="${opts.zoteroVersion ?? "9.0.6"}">` +
    `<session id="${session}"/>` +
    `<style id="${opts.styleId}" locale="${opts.locale ?? "en-US"}" hasBibliography="1" ` +
    `bibliographyStyleHasBeenSet="1"/>` +
    `<prefs><pref name="fieldType" value="Field"/>` +
    `<pref name="delayCitationUpdates" value="true"/></prefs></data>`;

  parts["word/document.xml"] = encode(documentXml);
  parts["docProps/custom.xml"] = encode(
    customProperties(blob, parts["docProps/custom.xml"] ? decode(parts["docProps/custom.xml"]) : null),
  );

  let contentTypes = decode(parts["[Content_Types].xml"]);
  if (!contentTypes.includes("docProps/custom.xml")) {
    contentTypes = contentTypes.replace(
      "</Types>",
      '<Override PartName="/docProps/custom.xml" ContentType="application/' +
        'vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>',
    );
    parts["[Content_Types].xml"] = encode(contentTypes);
  }
  let rels = decode(parts["_rels/.rels"]);
  if (!rels.includes("custom-properties")) {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="rId${(ids.length ? Math.max(...ids) : 0) + 1}" Type="http://schemas.openxmlformats.org/` +
        'officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>',
    );
    parts["_rels/.rels"] = encode(rels);
  }

  return { bytes: zipSync(parts), report };
}
