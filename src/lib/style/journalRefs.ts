// Journal reference entries — Nature, Science and Cell submission forms.
//
// Input is a CSL-JSON record (citation-js's parse of the project's BibTeX, the
// same records the Zotero-field path uses), because CSL-JSON carries what a
// submittable list needs and RefEntry does not: the item TYPE (book, chapter,
// dataset, software, thesis…), editors, publisher place, edition, version.
//
// Output is pandoc MARKDOWN (italic journal, bold volume…), so one string
// serves the Word and the PDF render alike. Every rule below is sourced in
// docs/journal_styleguide.md (§2.6 Nature, §3.6 Science, §4.7 Cell):
//   Nature  — ≤5 authors listed, else "First, A. et al." (upright et al.); "&"
//             with no comma; title; *Abbrev.* **vol**, pages (year). No DOI on
//             an ordinary article; repository/server + DOI URL for preprints,
//             datasets and software; books carry publisher AND city.
//   Science — EVERY author at submission, initials first, commas and no "and";
//             title; *Journal* **vol**, pages (year). DOI appended when known.
//   Cell    — ≤10 authors, else first 10 + ", et al."; serial ", and"; (Year).
//             after the authors; Abbrev. *vol*, full page range. https://doi.org/.
//
// Pure: no Svelte, no DOM, no Node. Twin-engine shared core (flux-core → src/lib).

import { abbrevJournal, dotAbbreviations } from "../references/journalAbbrev";
import type { CslRecord } from "../references/zoteroFields";

export type RefLayout = "nature" | "science" | "cell";

interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  suffix?: string;
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** CSL rich text → pandoc markdown: <i>/<b>/<sub>/<sup> kept, everything that
 *  pandoc would reinterpret escaped. `@` matters most: an unescaped one inside a
 *  title would be read as a citation. */
export function cslTextToMarkdown(s: string): string {
  const parts = s.split(/(<\/?(?:i|em|b|strong|sub|sup|span|sc)[^>]*>)/gi);
  let out = "";
  for (const p of parts) {
    const tag = /^<(\/?)(\w+)/.exec(p);
    if (tag) {
      const t = tag[2].toLowerCase();
      if (t === "i" || t === "em") out += "*";
      else if (t === "b" || t === "strong") out += "**";
      else if (t === "sub") out += "~";
      else if (t === "sup") out += "^";
      continue;
    }
    out += p
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/([\\`*_[\]^~@#<>|])/g, "\\$1");
  }
  return out.replace(/\s+/g, " ").trim();
}

const GENERATIONAL = /^(jr\.?|sr\.?|ii|iii|iv|v|2nd|3rd|4th|5th)$/i;

/** PubMed-sourced BibTeX writes "Wilson, D. M., 3rd", which BibTeX reads as
 *  von-Last-Jr-First with the generational suffix in the GIVEN slot and the
 *  initials in the suffix slot — swap them back. */
function normalizeName(n: CslName): CslName {
  if (n.given && GENERATIONAL.test(n.given.trim()) && n.suffix && /^[A-Z][. -]/.test(n.suffix.trim())) {
    return { ...n, given: n.suffix, suffix: n.given };
  }
  return n;
}

function names(rec: CslRecord, key = "author"): CslName[] {
  const v = rec[key];
  return Array.isArray(v) ? (v as CslName[]).filter((n) => n && (n.family || n.literal || n.given)).map(normalizeName) : [];
}

/** "Jean-Paul Marie" → ["J.-P.", "M."] */
function initialList(given: string): string[] {
  return given
    .replace(/\./g, ". ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .split("-")
        .map((p) => (p ? `${p[0].toUpperCase()}.` : ""))
        .join("-"),
    );
}

function familyOf(n: CslName): string {
  const particle = n["non-dropping-particle"] ? `${n["non-dropping-particle"]} ` : "";
  return cslTextToMarkdown(`${particle}${n.family ?? n.literal ?? ""}`);
}

/** Nature: "Watson, J. D." · Cell: "Watson, J.D." */
function surnameFirst(n: CslName, spacedInitials: boolean): string {
  if (n.literal && !n.family) return cslTextToMarkdown(n.literal);
  const fam = familyOf(n);
  const ini = n.given ? initialList(n.given).join(spacedInitials ? " " : "") : "";
  const suffix = n.suffix ? ` ${n.suffix}` : "";
  return ini ? `${fam}, ${ini}${suffix}` : `${fam}${suffix}`;
}

/** Science: "J. D. Watson", suffix with no punctuation before it ("J. Smith Jr."). */
function initialsFirst(n: CslName): string {
  if (n.literal && !n.family) return cslTextToMarkdown(n.literal);
  const ini = n.given ? initialList(n.given).join(" ") : "";
  const suffix = n.suffix ? ` ${n.suffix}` : "";
  return `${ini ? `${ini} ` : ""}${familyOf(n)}${suffix}`;
}

export function yearOf(rec: CslRecord): string {
  const dp = (rec.issued as { "date-parts"?: unknown[][]; literal?: string } | undefined) ?? undefined;
  const y = dp?.["date-parts"]?.[0]?.[0];
  if (y != null && String(y).trim()) return String(y).trim();
  return str(dp?.literal) || str(rec.year) || "n.d.";
}

/** En-dash page ranges, alphanumeric endpoints too (E3131–E3140, 1590–1608.e23).
 *  `expand` writes the full second number (Cell: "801–806", never "801–6"). */
export function pageRange(pages: string, expand = true): string {
  const s = pages.trim();
  const m = /^([A-Za-z]*)(\d+)([A-Za-z.\d]*)\s*(?:--|—|–|-)\s*([A-Za-z]*)(\d+)([A-Za-z.\d]*)$/.exec(s);
  if (!m) return s;
  let [, p1, n1, s1, p2, n2, s2] = m;
  if (expand && !p2 && n2.length < n1.length && !s1) n2 = n1.slice(0, n1.length - n2.length) + n2;
  return `${p1}${n1}${s1}–${p2}${n2}${s2}`;
}

const PREPRINT_SERVERS: [RegExp, string][] = [
  [/biorxiv/i, "bioRxiv"],
  [/medrxiv/i, "medRxiv"],
  [/arxiv|10\.48550/i, "arXiv"],
  [/chemrxiv/i, "ChemRxiv"],
  [/psyarxiv/i, "PsyArXiv"],
  [/research ?square/i, "Research Square"],
  [/ssrn/i, "SSRN"],
  [/preprints\.org/i, "Preprints.org"],
  [/osf\.io/i, "OSF Preprints"],
];

/** The server a preprint lives on, or null when the record is not a preprint. */
export function preprintServer(rec: CslRecord): string | null {
  const hay = [str(rec["container-title"]), str(rec.publisher), str(rec.URL), str(rec.DOI), str(rec.genre), str(rec.archive)]
    .join(" ")
    .toLowerCase();
  const typed = rec.type === "article" || str(rec.genre).toLowerCase() === "preprint" || rec.type === "manuscript";
  if (/10\.1101\//.test(str(rec.DOI))) {
    return /medrxiv/i.test(hay) ? "medRxiv" : "bioRxiv";
  }
  for (const [re, name] of PREPRINT_SERVERS) if (re.test(hay)) return name;
  if (typed && /preprint/.test(hay)) return "a preprint server";
  return null;
}

function arxivId(rec: CslRecord): string | null {
  const m = /(?:arxiv[.:/](?:abs\/)?|10\.48550\/arxiv\.)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7})/i.exec(
    `${str(rec.DOI)} ${str(rec.URL)} ${str(rec.number)} ${str(rec["container-title"])}`,
  );
  return m ? m[1] : null;
}

/** Journal-name abbreviation per venue. PNAS is the one title every venue
 *  prints differently, so it is pinned per layout. */
export function journalName(container: string, layout: RefLayout, short?: string): string {
  const key = container.trim().toLowerCase().replace(/\.$/, "");
  if (/^proceedings of the national academy of sciences/.test(key) || key === "pnas" || key === "proc natl acad sci u s a") {
    return layout === "nature" ? "Proc. Natl Acad. Sci. USA" : layout === "science" ? "Proc. Natl. Acad. Sci. U.S.A." : "Proc. Natl. Acad. Sci. USA";
  }
  const ab = dotAbbreviations(short?.trim() ? short.trim() : abbrevJournal(container));
  // Nature drops the full stop on contractions (Natl, Dept, Int'l) — Nature style.
  return layout === "nature" ? ab.replace(/\bNatl\./g, "Natl") : ab;
}

const doiUrl = (doi: string) => `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
const bareDoi = (doi: string) => doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
const end = (s: string) => (/[.?!]$/.test(s.replace(/\*+$/, "")) ? s : `${s}.`);

export type RefKind =
  | "article"
  | "preprint"
  | "book"
  | "chapter"
  | "proceedings"
  | "thesis"
  | "dataset"
  | "software"
  | "report"
  | "webpage";

export function refKind(rec: CslRecord): RefKind {
  const t = str(rec.type);
  if (preprintServer(rec) && t !== "book" && t !== "chapter" && t !== "dataset") return "preprint";
  switch (t) {
    case "book":
      return "book";
    case "chapter":
    case "entry-encyclopedia":
    case "entry-dictionary":
      return "chapter";
    case "paper-conference":
      return "proceedings";
    case "thesis":
      return "thesis";
    case "dataset":
      return "dataset";
    case "software":
      return "software";
    case "report":
      return "report";
    case "webpage":
    case "post-weblog":
    case "post":
      return "webpage";
    case "article-journal":
    case "article-magazine":
    case "article-newspaper":
    case "review":
      return "article";
    default:
      if (rec["container-title"]) return "article";
      if (rec.publisher && /zenodo|figshare|dryad|osf|github|code ocean/i.test(str(rec.publisher))) return "dataset";
      if (rec.publisher) return "book";
      return rec.URL ? "webpage" : "article";
  }
}

interface Parts {
  rec: CslRecord;
  kind: RefKind;
  title: string;
  container: string;
  volume: string;
  issue: string;
  pages: string;
  year: string;
  doi: string;
  url: string;
  publisher: string;
  place: string;
  edition: string;
  version: string;
  number: string;
  genre: string;
}

function parts(rec: CslRecord): Parts {
  return {
    rec,
    kind: refKind(rec),
    title: cslTextToMarkdown(str(rec.title)),
    container: str(rec["container-title"]),
    volume: str(rec.volume),
    issue: str(rec.issue),
    pages: str(rec.page) || str(rec["article-number"]) || "",
    year: yearOf(rec),
    doi: str(rec.DOI),
    url: str(rec.URL),
    publisher: cslTextToMarkdown(str(rec.publisher)),
    place: cslTextToMarkdown(str(rec["publisher-place"])),
    edition: str(rec.edition),
    version: str(rec.version),
    number: str(rec.number),
    genre: str(rec.genre),
  };
}

function thesisGenre(g: string): string {
  if (!g || /^phd|phdthesis|doctoral|dissertation/i.test(g)) return "PhD thesis";
  if (/master|msc|mastersthesis/i.test(g)) return "MSc thesis";
  return g;
}

function editionText(ed: string): string {
  if (!ed) return "";
  const n = /^\d+/.exec(ed)?.[0];
  return n ? `ed. ${n}` : ed;
}

// ------------------------------------------------------------------ Nature

function natureAuthorList(ns: CslName[], max = 5): string {
  if (!ns.length) return "";
  if (ns.length > max) return `${surnameFirst(ns[0], true)} et al.`;
  const list = ns.map((n) => surnameFirst(n, true));
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
}

function natureEditors(ns: CslName[]): string {
  if (!ns.length) return "";
  const list = ns.length > 5 ? `${surnameFirst(ns[0], true)} et al.` : natureAuthorList(ns, 5);
  return `${ns.length > 1 ? "eds" : "ed."} ${list}`;
}

function formatNature(p: Parts): string {
  const authors = natureAuthorList(names(p.rec));
  const head = authors ? `${end(authors)} ` : "";
  const title = p.title ? `${end(p.title)} ` : "";
  const pub = (extra: string[] = []) => [p.publisher, p.place, ...extra, p.year].filter(Boolean).join(", ");
  switch (p.kind) {
    case "preprint": {
      const server = preprintServer(p.rec);
      const id = p.doi ? doiUrl(p.doi) : p.url;
      return `${head}${title}Preprint at ${server && server !== "a preprint server" ? `${server} ` : ""}${id} (${p.year}).`;
    }
    case "dataset":
    case "software": {
      const repo = p.publisher || p.container || (p.url.includes("github.com") ? "GitHub" : "");
      const id = p.doi ? doiUrl(p.doi) : p.url;
      return `${head}${title}${repo ? `${repo} ` : ""}${id} (${p.year}).`;
    }
    case "book": {
      const eds = names(p.rec, "editor");
      const lead = authors ? head : eds.length ? `${natureEditors(eds).replace(/^eds?\.? /, "")} (${eds.length > 1 ? "eds" : "ed."}) ` : "";
      return `${lead}*${p.title}* (${pub([editionText(p.edition)].filter(Boolean))}).`;
    }
    case "chapter":
    case "proceedings": {
      const eds = names(p.rec, "editor");
      const book = p.container ? (p.kind === "proceedings" && !/^proc/i.test(p.container) ? `Proc. ${p.container}` : p.container) : "";
      const vol = p.volume ? ` Vol. ${p.volume}` : "";
      const edsTxt = eds.length ? ` (${natureEditors(eds)})` : "";
      const pages = p.pages ? ` ${pageRange(p.pages)}` : "";
      return `${head}${title}In *${cslTextToMarkdown(book)}*${vol}${edsTxt}${pages} (${pub()}).`;
    }
    case "thesis":
      return `${head}${title}${thesisGenre(p.genre)}, ${p.publisher || "Univ."} (${p.year}).`;
    case "report":
      return `${head}*${p.title}*${p.number ? ` Report No. ${p.number}` : ""} (${pub()}).`;
    case "webpage":
      return `${head}${title}${p.url} (${p.year}).`;
    default: {
      const journal = p.container ? `*${cslTextToMarkdown(journalName(p.container, "nature", str(p.rec["container-title-short"])))}*` : "";
      const vol = p.volume ? ` **${p.volume}**` : "";
      const pages = p.pages ? `, ${pageRange(p.pages)}` : "";
      if (!p.volume && p.doi) return `${head}${title}${journal} ${doiUrl(p.doi)} (${p.year}).`;
      return `${head}${title}${journal}${vol}${pages} (${p.year}).`.replace(/\s+\(/, " (");
    }
  }
}

// ----------------------------------------------------------------- Science

function scienceAuthorList(ns: CslName[]): string {
  return ns.map(initialsFirst).join(", ");
}

function scienceEditors(ns: CslName[]): string {
  return ns.length ? `${scienceAuthorList(ns)}, ${ns.length > 1 ? "Eds." : "Ed."}` : "";
}

function formatScience(p: Parts): string {
  const authors = scienceAuthorList(names(p.rec));
  const lead = authors ? `${authors}, ` : "";
  const doiTail = p.doi ? ` doi:${bareDoi(p.doi)}` : "";
  switch (p.kind) {
    case "preprint": {
      const ax = arxivId(p.rec);
      if (ax) return `${lead}${end(p.title)} arXiv:${ax} (${p.year}).`;
      const server = preprintServer(p.rec) ?? "Preprint";
      const id = p.doi ? bareDoi(p.doi).replace(/^10\.1101\//, "") : p.number;
      return `${lead}${end(p.title)} ${server}${id ? ` ${id}` : ""} [Preprint] (${p.year}).${p.doi ? ` ${doiUrl(p.doi)}.` : p.url ? ` ${p.url}.` : ""}`;
    }
    case "dataset":
    case "software": {
      const repo = p.publisher || p.container || (p.url.includes("github.com") ? "GitHub" : "");
      const bits = [p.title, p.version ? `version ${p.version}` : "", repo].filter(Boolean).join(", ");
      const id = p.doi ? doiUrl(p.doi) : p.url;
      return `${lead}${bits} (${p.year})${id ? `; ${id}` : ""}.`;
    }
    case "book": {
      const eds = names(p.rec, "editor");
      const who = authors ? lead : eds.length ? `${scienceEditors(eds)} ` : "";
      const tail = [p.publisher, editionText(p.edition), p.year].filter(Boolean).join(", ");
      return `${who}*${p.title}* (${tail}).`;
    }
    case "chapter":
    case "proceedings": {
      const eds = names(p.rec, "editor");
      const edTxt = eds.length ? `, ${scienceEditors(eds)}` : "";
      const pages = p.pages ? `, pp. ${pageRange(p.pages)}` : "";
      const tail = [p.publisher, p.year].filter(Boolean).join(", ");
      return `${lead}${p.title ? `"${p.title}" ` : ""}in *${cslTextToMarkdown(p.container)}*${edTxt} (${tail})${pages}.`;
    }
    case "thesis":
      return `${lead}${p.title ? `"${p.title}," ` : ""}thesis, ${p.publisher || "University"} (${p.year}).`;
    case "report":
      return `${lead}"${p.title}" (${[p.number ? `Tech. Rep. ${p.number}` : "", p.publisher, p.year].filter(Boolean).join(", ")})${p.url ? `; ${p.url}` : ""}.`;
    case "webpage":
      return `${lead}"${p.title}" (${p.year})${p.url ? `; ${p.url}` : ""}.`;
    default: {
      const journal = p.container ? `*${cslTextToMarkdown(journalName(p.container, "science", str(p.rec["container-title-short"])))}*` : "";
      // Early online (no volume yet): the DOI takes the place of volume and pages.
      if (!p.volume && (p.doi || !p.pages)) return `${lead}${end(p.title)} ${journal}${p.doi ? ` ${bareDoi(p.doi)}` : ""} (${p.year}).`;
      // Science: no comma before the volume or before any parentheses.
      const vol = p.volume ? ` **${p.volume}**` : ` **${p.year}**`;
      const pages = p.pages ? `, ${pageRange(p.pages)}` : "";
      return `${lead}${end(p.title)} ${journal}${vol}${pages} (${p.year}).${doiTail}`;
    }
  }
}

// -------------------------------------------------------------------- Cell

function cellAuthorList(ns: CslName[]): string {
  if (!ns.length) return "";
  if (ns.length > 10) return `${ns.slice(0, 10).map((n) => surnameFirst(n, false)).join(", ")}, et al.`;
  const list = ns.map((n) => surnameFirst(n, false));
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function cellEditors(ns: CslName[]): string {
  if (!ns.length) return "";
  const list = ns.map((n) => `${n.given ? initialList(n.given).join("") + " " : ""}${familyOf(n)}`);
  const joined = list.length === 1 ? list[0] : list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
  return `${joined}, ${ns.length > 1 ? "eds." : "ed."}`;
}

function formatCell(p: Parts): string {
  const authors = cellAuthorList(names(p.rec));
  const eds = names(p.rec, "editor");
  const who = authors || (eds.length && (p.kind === "book") ? cellAuthorList(eds) + (eds.length > 1 ? ", eds." : ", ed.") : "");
  const head = `${who ? `${who.replace(/\.$/, "")}${who.endsWith(".") ? "." : ""} ` : ""}(${p.year}). `;
  const title = p.title ? `${end(p.title)} ` : "";
  const doi = p.doi ? ` ${doiUrl(p.doi)}.` : "";
  switch (p.kind) {
    case "preprint": {
      const server = preprintServer(p.rec);
      return `${head}${title}Preprint at ${server ?? "a preprint server"}.${p.doi ? ` ${doiUrl(p.doi)}.` : p.url ? ` ${p.url}.` : ""}`;
    }
    case "dataset":
    case "software": {
      const repo = p.publisher || p.container || (p.url.includes("github.com") ? "GitHub" : "");
      if (!p.doi && !p.url) return `${head}${p.title}${repo ? ` (${repo})` : ""}.`;
      return `${head}${title}${repo ? `${end(repo)}` : ""}${p.doi ? ` ${doiUrl(p.doi)}.` : ` ${p.url}.`}`;
    }
    case "book":
      return `${head}${p.title}${p.edition ? `, ${editionText(p.edition).replace(/^ed\. (\d+)/, "$1 Edition")}` : ""} (${p.publisher || "Publisher"}).${doi}`;
    case "chapter":
    case "proceedings": {
      const edTxt = eds.length ? `, ${cellEditors(eds)}` : "";
      const pages = p.pages ? `, pp. ${pageRange(p.pages, true)}` : "";
      return `${head}${title}In ${cslTextToMarkdown(p.container)}${edTxt}${p.publisher ? ` (${p.publisher})` : ""}${pages}.${doi}`;
    }
    case "thesis":
      return `${head}${title}${thesisGenre(p.genre)} (${p.publisher || "University"}).${doi}`;
    case "report":
      return `${head}${title}${p.number ? `${p.number} ` : ""}(${p.publisher || "Report"}).${doi || (p.url ? ` ${p.url}.` : "")}`;
    case "webpage":
      return `${head}${title}${p.url}.`;
    default: {
      const journal = p.container ? cslTextToMarkdown(journalName(p.container, "cell", str(p.rec["container-title-short"]))) : "";
      if (!p.volume && p.doi) return `${head}${title}${journal}.${doi}`;
      const vol = p.volume ? ` *${p.volume}*` : "";
      const pages = p.pages ? `, ${pageRange(p.pages, true)}` : "";
      return `${head}${title}${journal}${vol}${pages}.${doi}`.replace(/ \./g, ".");
    }
  }
}

/** One reference entry, as pandoc markdown, in the venue's submission form. */
export function formatJournalReference(rec: CslRecord, layout: RefLayout): string {
  const p = parts(rec);
  const s = layout === "nature" ? formatNature(p) : layout === "science" ? formatScience(p) : formatCell(p);
  return s.replace(/\s+/g, " ").replace(/\.\./g, ".").replace(/,\s*,/g, ",").trim();
}

/** Narrative author label for "@key" citations: "Smith", "Smith and Jones",
 *  "Smith et al." — what every venue prints before the reference mark. */
export function narrativeAuthors(rec: CslRecord | undefined): string {
  const ns = rec ? names(rec) : [];
  if (!ns.length) {
    const eds = rec ? names(rec, "editor") : [];
    if (!eds.length) return "";
    return familyOf(eds[0]) + (eds.length > 1 ? " et al." : "");
  }
  if (ns.length === 1) return familyOf(ns[0]);
  if (ns.length === 2) return `${familyOf(ns[0])} and ${familyOf(ns[1])}`;
  return `${familyOf(ns[0])} et al.`;
}
