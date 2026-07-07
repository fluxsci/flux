// RIS import (2.4 bulk import) — a dependency-free RIS→BibTeX converter. Reference
// managers (EndNote, Zotero, Mendeley, PubMed, Web of Science) all export RIS; rather
// than teach the library a second ingestion format, we normalize RIS into BibTeX up
// front so it flows through the ONE canonical add path (planAdds → addToFluxLib) — same
// dedupe, same rekey, same PDF-attach — as a pasted .bib. Pure + fully testable.
import type { RefEntry } from "./types";
import { makeCitekey } from "./citekey";

// RIS reference-type tag (TY) → BibTeX entry type. Anything unmapped falls to @misc.
const TYPE_MAP: Record<string, string> = {
  JOUR: "article",
  JFULL: "article",
  ABST: "article",
  INPR: "article",
  BOOK: "book",
  EBOOK: "book",
  CHAP: "incollection",
  ECHAP: "incollection",
  CONF: "inproceedings",
  CPAPER: "inproceedings",
  THES: "phdthesis",
  RPRT: "techreport",
  UNPB: "unpublished",
};

type RisRecord = Record<string, string[]>; // tag → values (tags repeat, e.g. AU)

/** Split RIS text into records (TY … ER), each a tag→values map. Wrapped lines
 *  (continuations with no tag) append to the previous field. Tolerant of `TY  - `
 *  (2-space) and `TY - ` spacing variants and of leading junk before the first TY. */
function parseRisRecords(text: string): RisRecord[] {
  const TAG = /^([A-Z][A-Z0-9])\s{1,4}-\s?(.*)$/;
  const records: RisRecord[] = [];
  let cur: RisRecord | null = null;
  let lastTag: string | null = null;
  for (const rawLine of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const m = TAG.exec(rawLine);
    if (m) {
      const tag = m[1];
      const val = m[2].trim();
      if (tag === "TY") {
        cur = { TY: [val] };
        records.push(cur);
        lastTag = "TY";
      } else if (tag === "ER") {
        cur = null;
        lastTag = null;
      } else if (cur) {
        (cur[tag] ||= []).push(val);
        lastTag = tag;
      }
    } else if (cur && lastTag && rawLine.trim()) {
      const arr = cur[lastTag];
      if (arr?.length) arr[arr.length - 1] += " " + rawLine.trim();
    }
  }
  return records;
}

const first = (r: RisRecord, ...tags: string[]): string => {
  for (const t of tags) if (r[t]?.[0]) return r[t][0];
  return "";
};
const all = (r: RisRecord, ...tags: string[]): string[] => tags.flatMap((t) => r[t] ?? []);
const year4 = (s: string): string => s.match(/\d{4}/)?.[0] ?? "";
const cleanDoi = (s: string): string => s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();

/** One RIS record → the flat RefEntry the app dedupes on (key filled by the caller). */
function risToEntry(r: RisRecord): Omit<RefEntry, "key"> & { fields: Record<string, string> } {
  const authors = all(r, "AU", "A1").map((a) => a.trim()).filter(Boolean);
  const editors = all(r, "ED", "A2").map((a) => a.trim()).filter(Boolean);
  const type = r.TY?.[0] ?? "";
  const isChapterOrConf = type === "CHAP" || type === "ECHAP" || type === "CONF" || type === "CPAPER";
  const title = first(r, "TI", "T1", "BT");
  const container = isChapterOrConf ? first(r, "T2", "BT") : first(r, "JO", "JF", "JA", "T2");
  const year = year4(first(r, "PY", "Y1", "DA"));
  const sp = first(r, "SP");
  const ep = first(r, "EP");
  const pages = sp && ep ? `${sp}--${ep}` : sp || "";
  const doi = cleanDoi(first(r, "DO"));
  const volume = first(r, "VL");
  const issue = first(r, "IS", "CP");
  const publisher = first(r, "PB");
  const url = first(r, "UR");
  const abstract = first(r, "AB", "N2");
  const keywords = all(r, "KW").join(", ");
  const issn = first(r, "SN");

  const fields: Record<string, string> = {};
  const put = (k: string, v: string) => v && (fields[k] = v);
  put(container.length ? (isChapterOrConf ? "booktitle" : "journal") : "", container);
  put("volume", volume);
  put("number", issue);
  put("pages", pages);
  put("publisher", publisher);
  put("doi", doi);
  put("url", url);
  put("abstract", abstract);
  put("keywords", keywords);
  put(issn.includes("-") || /^\d{4}/.test(issn) ? "issn" : "isbn", issn);
  if (editors.length) put("editor", editors.join(" and "));

  return {
    title,
    authors: authors.length ? authors.map((a) => a.split(",")[0].trim()).filter(Boolean) : editors.map((e) => e.split(",")[0].trim()),
    year,
    container: container || undefined,
    doi: doi || undefined,
    url: url || undefined,
    volume: volume || undefined,
    issue: issue || undefined,
    pages: pages || undefined,
    publisher: publisher || undefined,
    fields: { ...fields, ...(authors.length ? { author: authors.join(" and ") } : {}), title, year },
  };
}

const bibValue = (s: string): string => s.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

/** Convert RIS text to BibTeX text (one @block per record), minting stable citekeys
 *  disambiguated within the batch. Records with no title AND no author are skipped. */
export function risToBibtex(risText: string): string {
  const taken = new Set<string>();
  const blocks: string[] = [];
  for (const rec of parseRisRecords(risText)) {
    const e = risToEntry(rec);
    if (!e.title && !e.authors.length) continue;
    const type = TYPE_MAP[rec.TY?.[0] ?? ""] ?? "misc";
    const key = makeCitekey({ authors: e.authors, year: e.year, title: e.title }, taken);
    taken.add(key);
    const lines = Object.entries(e.fields)
      .filter(([, v]) => v && v.trim())
      .map(([k, v]) => `  ${k} = {${bibValue(v)}}`);
    blocks.push(`@${type}{${key},\n${lines.join(",\n")},\n}`);
  }
  return blocks.join("\n\n");
}

/** Detect the pasted/loaded reference format so the importer can route it. */
export function sniffFormat(text: string): "bibtex" | "ris" | "unknown" {
  const t = text.replace(/^﻿/, "").trimStart();
  if (!t) return "unknown";
  if (/^TY\s{1,4}-/m.test(t)) return "ris";
  if (/(^|\n)\s*@[a-zA-Z]+\s*\{/.test(t)) return "bibtex";
  return "unknown";
}
