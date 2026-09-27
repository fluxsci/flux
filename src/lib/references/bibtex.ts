import { scanBib, rawBibField, bibMacroMap, projectBibValue } from "./bibScanner";
// Shared BibTeX/CSL helpers used by the renderer (scholar UI), flux-core
// (CLI/MCP), and the FluxLib engine. Citation.js is dynamic-imported so it stays
// off any editor hot path and out of the CLI's startup cost until first use.
import type { RefEntry } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let CiteCtor: any = null;
/** Lazily load Citation.js (core + bibtex/doi/csl plugins) and cache the Cite ctor. */
export async function getCite(): Promise<any> {
  if (!CiteCtor) {
    const core = await import("@citation-js/core");
    await import("@citation-js/plugin-bibtex");
    await import("@citation-js/plugin-doi");
    await import("@citation-js/plugin-csl");
    CiteCtor = core.Cite;
  }
  return CiteCtor;
}

/** Map one Citation.js CSL record to the flat RefEntry the app uses. */
export function cslToEntry(c: any): RefEntry {
  const authors: string[] = (c.author ?? [])
    .map((a: any) => a.family || a.literal || a.name || a.given || "")
    .filter(Boolean);
  const authorsFull = (c.author ?? [])
    .map((a: any) => ({ family: a.family || a.literal || a.name || "", given: a.given || undefined }))
    .filter((a: { family: string }) => a.family);
  const year =
    c.issued?.["date-parts"]?.[0]?.[0]?.toString() ??
    c.issued?.year?.toString() ??
    "";
  const container = Array.isArray(c["container-title"])
    ? c["container-title"][0]
    : c["container-title"];
  return {
    key: c.id || c["citation-key"] || "",
    title: Array.isArray(c.title) ? c.title[0] : (c.title ?? ""),
    authors,
    year,
    container: container || undefined,
    doi: c.DOI || undefined,
    url: c.URL || undefined,
    volume: c.volume != null ? String(c.volume) : undefined,
    issue: c.issue != null ? String(c.issue) : undefined,
    pages: c.page != null ? String(c.page) : undefined,
    publisher: c.publisher || undefined,
    authorsFull: authorsFull.length ? authorsFull : undefined,
  };
}

/** Parse BibTeX (or any Citation.js-supported input) into RefEntry[]. */
export async function parseBib(text: string): Promise<RefEntry[]> {
  if (!text.trim()) return [];
  const Cite = await getCite();
  const cite = new Cite(text);
  return (cite.data as any[]).map(cslToEntry).filter((e) => e.key);
}

/**
 * Brace-balanced split of a .bib string into individual raw entry strings.
 * Good enough for well-formed BibLaTeX (doesn't special-case braces inside
 * quoted strings, which are rare); each result starts at its `@`.
 */
export function splitBibEntries(text: string): string[] {
  return scanBib(text).records.filter(r => r.kind === "entry").map(r => text.slice(r.start, r.end));
}
export function bibtexKey(raw: string): string | null {
  return scanBib(raw).records.find(r => r.kind === "entry")?.key || null;
}
export function normalizeDoi(value: string): string {
  return value.trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").trim().toLowerCase();
}
export function bibtexDoi(raw: string): string | undefined {
  const value = rawBibField(raw, "doi");
  return value ? normalizeDoi(value) : undefined;
}
export function rekeyBibtex(raw: string, newKey: string): string {
  const entry = scanBib(raw).records.find(r => r.kind === "entry");
  return entry ? raw.slice(0, entry.keyStart) + newKey + raw.slice(entry.keyEnd) : raw;
}
export function stampDateAdded(raw: string, iso: string): string {
  const entry = scanBib(raw).records.find(r => r.kind === "entry");
  if (!entry) return raw;
  const field = entry.fields.find(f => f.name === "dateadded");
  if (field) return raw.slice(0, field.valueStart) + `{${iso}}` + raw.slice(field.valueEnd);
  const comma = raw.indexOf(",", entry.keyEnd);
  return comma >= 0 && comma < entry.end ? raw.slice(0, comma + 1) + `\n  dateadded = {${iso}},` + raw.slice(comma + 1) : raw;
}
function bibField(raw: string, name: string): string {
  return (rawBibField(raw, name) ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Cheap, dependency-free extraction of a single raw BibTeX entry into a RefEntry,
 * used by flux-core so the CLI/MCP stay light (no Citation.js at runtime). Coarser
 * than parseBib() — notably author-particle handling — but adequate for citekey
 * generation, DOI dedup, and search. Both paths yield the same RefEntry shape.
 */
export function decodeBibDisplay(value: string): string {
  const marks: Record<string, string> = {"'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304", ".": "\u0307", "u": "\u0306", "v": "\u030c", "H": "\u030b", "c": "\u0327"};
  return value.replace(/\\([\'`^"~=.uvHc])\s*\{?([A-Za-z])\}?/g, (_, accent: string, letter: string) => (letter + marks[accent]).normalize("NFC"))
    .replace(/\\(ss|ae|AE|oe|OE|o|O|l|L)(?:\{\}|\b)/g, (_, code: string) => ({ss:"ß", ae:"æ", AE:"Æ", oe:"œ", OE:"Œ", o:"ø", O:"Ø", l:"ł", L:"Ł"}[code] ?? code))
    .replace(/\\([&%_$#{}])/g, "$1").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
export function lightBibEntries(text: string): RefEntry[] {
  const macros = bibMacroMap(text);
  return splitBibEntries(text).map(raw => lightEntry(raw, macros));
}
export function lightEntry(raw: string, macroMap?: Map<string, string> | number): RefEntry {
  const macros = macroMap instanceof Map ? macroMap : new Map<string, string>();
  const parsed = scanBib(raw).records.find(r => r.kind === "entry");
  const fields = new Map(parsed?.fields.map(f => [f.name, projectBibValue(f, macros)]) ?? []);
  const field = (name: string) => decodeBibDisplay(fields.get(name) ?? "");
  const authorRaw = field("author");
  const tokens = authorRaw ? authorRaw.split(/\s+and\s+/i).filter((t) => t.trim()) : [];
  const authors = tokens
    .map((a) => (a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop() || a).trim())
    .filter(Boolean);
  // 2.2: full names for the reference-list formatter. "Family, Given" splits
  // exactly; "Given Family" takes the last word as family, the rest as given.
  const authorsFull = tokens
    .map((a) => {
      const t = a.trim();
      if (t.includes(",")) {
        const [family, ...rest] = t.split(",");
        return { family: family.trim(), given: rest.join(",").trim() || undefined };
      }
      const words = t.split(/\s+/);
      const family = words.pop() ?? "";
      return { family, given: words.join(" ") || undefined };
    })
    .filter((a) => a.family);
  const year = field("year") || (field("date").match(/\d{4}/)?.[0] ?? "");
  const doi = normalizeDoi(field("doi"));
  return {
    key: parsed?.key || "",
    title: field("title"),
    authors,
    year,
    container: field("journal") || field("journaltitle") || field("booktitle") || undefined,
    doi: doi || undefined,
    url: field("url") || undefined,
    volume: field("volume") || undefined,
    issue: field("number") || field("issue") || undefined,
    pages: field("pages") || undefined,
    publisher: field("publisher") || undefined,
    authorsFull: authorsFull.length ? authorsFull : undefined,
    dateAdded: field("dateadded") || undefined,
    raw,
  };
}
