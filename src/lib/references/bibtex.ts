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
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const open = text.indexOf("{", at);
    if (open < 0) break;
    let depth = 0;
    let j = open;
    for (; j < n; j++) {
      const ch = text[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    out.push(text.slice(at, j).trim());
    i = j;
  }
  return out;
}

/** The citekey of a single raw BibTeX entry, or null. */
export function bibtexKey(raw: string): string | null {
  const m = raw.match(/@\w+\s*\{\s*([^,\s]+)/);
  return m ? m[1] : null;
}

/** The DOI of a single raw BibTeX entry, normalized to a bare lowercase DOI. */
export function bibtexDoi(raw: string): string | undefined {
  const m = raw.match(/\bdoi\s*=\s*[{"]?\s*([^,}"\s]+)/i);
  return m
    ? m[1].replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase()
    : undefined;
}

/** Replace the citekey of a single raw BibTeX entry with `newKey`. */
export function rekeyBibtex(raw: string, newKey: string): string {
  return raw.replace(/(@\w+\s*\{\s*)[^,\s]+/, `$1${newKey}`);
}

/** Read one `name = {…}` / `name = "…"` / bare field from a raw BibTeX entry. */
function bibField(raw: string, name: string): string {
  const m = raw.match(new RegExp("\\b" + name + "\\s*=\\s*", "i"));
  if (!m || m.index == null) return "";
  let i = m.index + m[0].length;
  const open = raw[i];
  if (open === "{") {
    let depth = 1;
    let j = i + 1;
    for (; j < raw.length && depth > 0; j++) {
      if (raw[j] === "{") depth++;
      else if (raw[j] === "}") depth--;
    }
    return raw.slice(i + 1, j - 1).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  }
  if (open === '"') {
    const end = raw.indexOf('"', i + 1);
    return end < 0 ? "" : raw.slice(i + 1, end).replace(/\s+/g, " ").trim();
  }
  const bare = raw.slice(i).match(/^([^,\n}]+)/);
  return bare ? bare[1].trim() : "";
}

/**
 * Cheap, dependency-free extraction of a single raw BibTeX entry into a RefEntry,
 * used by flux-core so the CLI/MCP stay light (no Citation.js at runtime). Coarser
 * than parseBib() — notably author-particle handling — but adequate for citekey
 * generation, DOI dedup, and search. Both paths yield the same RefEntry shape.
 */
export function lightEntry(raw: string): RefEntry {
  const authorRaw = bibField(raw, "author");
  const authors = authorRaw
    ? authorRaw
        .split(/\s+and\s+/i)
        .map((a) => (a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop() || a).trim())
        .filter(Boolean)
    : [];
  const year = bibField(raw, "year") || (bibField(raw, "date").match(/\d{4}/)?.[0] ?? "");
  const doi = (bibField(raw, "doi") || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return {
    key: bibtexKey(raw) || "",
    title: bibField(raw, "title"),
    authors,
    year,
    container: bibField(raw, "journal") || bibField(raw, "booktitle") || undefined,
    doi: doi || undefined,
    url: bibField(raw, "url") || undefined,
    raw,
  };
}
