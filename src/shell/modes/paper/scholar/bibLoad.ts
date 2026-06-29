// Loads + grows the bibliography. Parsing existing BibTeX is the hard direction,
// so we lean on Citation.js (dynamic-imported to stay off the editor hot path).
// Growing it from a pasted DOI is the easy direction — we generate a BibTeX
// entry from the CrossRef metadata ourselves (Flux_Paper_Plan.md B5).

import { get } from "svelte/store";
import { fileBridge, joinPath } from "../../../../lib/project/types";
import { bibEntries, bibError, type BibEntry } from "./bib";
import { bumpBibRevision } from "../../../scholar/revisions";

const BIB_PATH = ["references", "library.bib"];

/* eslint-disable @typescript-eslint/no-explicit-any */
let CiteCtor: any = null;
async function getCite(): Promise<any> {
  if (!CiteCtor) {
    const core = await import("@citation-js/core");
    await import("@citation-js/plugin-bibtex");
    await import("@citation-js/plugin-doi");
    await import("@citation-js/plugin-csl");
    CiteCtor = core.Cite;
  }
  return CiteCtor;
}

function cslToEntry(c: any): BibEntry {
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

/** Parse `references/library.bib` into the bib store. Safe no-op without a project. */
export async function loadBib(root: string | null): Promise<void> {
  const fb = fileBridge();
  if (!root || !fb) return;
  const path = joinPath(root, ...BIB_PATH);
  let text = "";
  try {
    if (!(await fb.exists(path))) {
      bibEntries.set([]);
      return;
    }
    text = await fb.readText(path);
  } catch {
    return;
  }
  if (!text.trim()) {
    bibEntries.set([]);
    bibError.set(null);
    return;
  }
  try {
    const Cite = await getCite();
    const cite = new Cite(text);
    const entries = (cite.data as any[]).map(cslToEntry).filter((e) => e.key);
    bibEntries.set(entries);
    // M12: parsed, but a non-empty file yielding nothing usually means malformed
    // entries Citation.js skipped — say so rather than silently showing "no refs".
    const atCount = (text.match(/^[ \t]*@/gm) ?? []).length;
    bibError.set(
      atCount > 0 && entries.length === 0
        ? `Couldn't parse library.bib — 0 of ~${atCount} entries loaded.`
        : entries.length < atCount
          ? `Partially parsed library.bib — ${entries.length} of ~${atCount} entries loaded.`
          : null,
    );
  } catch (err) {
    console.error("[flux] library.bib parse failed", err);
    bibEntries.set([]);
    bibError.set("Couldn't parse library.bib — check the file for syntax errors.");
  }
}

// ---- DOI → BibTeX (generation; the easy direction) ------------------------
function first<T>(v: T | T[] | undefined): T | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function crossrefAuthors(msg: any): { family: string; given?: string }[] {
  return (msg.author ?? []).map((a: any) => ({
    family: a.family || a.name || "",
    given: a.given || undefined,
  }));
}
function crossrefYear(msg: any): string {
  const dp = (msg.issued ?? msg["published-print"] ?? msg["published-online"])?.[
    "date-parts"
  ]?.[0];
  return dp?.[0]?.toString() ?? "";
}

function makeKey(family: string, year: string, title: string, taken: Set<string>): string {
  const a = (family || "anon").toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = (title.split(/\s+/).find((x) => x.replace(/[^a-z]/gi, "").length > 3) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  let base = `${a}${year}${w}`.slice(0, 40) || "ref";
  let key = base;
  let n = 0;
  while (taken.has(key)) key = base + String.fromCharCode(97 + ++n); // a, b, c…
  return key;
}

function toBibtex(key: string, msg: any, entry: BibEntry): string {
  const authorField = crossrefAuthors(msg)
    .map((a) => (a.given ? `${a.family}, ${a.given}` : a.family))
    .filter(Boolean)
    .join(" and ");
  const type = /book/.test(msg.type ?? "") ? "book" : "article";
  const fields: [string, string | undefined][] = [
    ["title", entry.title],
    ["author", authorField],
    ["year", entry.year],
    ["journal", entry.container],
    ["volume", msg.volume],
    ["number", msg.issue],
    ["pages", first<string>(msg.page)],
    ["publisher", msg.publisher],
    ["doi", entry.doi],
    ["url", entry.url],
  ];
  const body = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(",\n");
  return `\n@${type}{${key},\n${body},\n}\n`;
}

/** Fetch a DOI's metadata, append a BibTeX entry to library.bib, return the new entry. */
export async function addDoiToBib(
  doi: string,
  root: string | null,
): Promise<BibEntry | { error: string }> {
  const fb = fileBridge();
  if (!fb?.fetchDoi) return { error: "DOI lookup needs the desktop app." };
  const res = await fb.fetchDoi(doi);
  if (!res || res.error || !res.message)
    return { error: res?.error || "Not found" };
  const msg = res.message as any;

  const authors = crossrefAuthors(msg);
  const year = crossrefYear(msg);
  const title = first<string>(msg.title) ?? "";
  const taken = new Set(get(bibEntries).map((e) => e.key));
  const key = makeKey(authors[0]?.family ?? "", year, title, taken);

  const entry: BibEntry = {
    key,
    title,
    authors: authors.map((a) => a.family).filter(Boolean),
    year,
    container: first<string>(msg["container-title"]) || undefined,
    doi: msg.DOI || doi,
    url: msg.URL || undefined,
  };

  if (root) {
    const path = joinPath(root, ...BIB_PATH);
    let prev = "";
    try {
      if (await fb.exists(path)) prev = await fb.readText(path);
    } catch {
      /* fresh file */
    }
    await fb.writeText(path, prev + toBibtex(key, msg, entry));
    // WS6: provenance for the human's reference add (Electron only).
    const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
    host?.journalAppend?.({ action: "cite", target: key, client: "human" });
  }
  bibEntries.update((list) => [...list, entry]);
  bumpBibRevision();
  return entry;
}

// Dev probe: verify Citation.js loads + parses in the real Vite/browser env
// (the file-bridge path can't run in the browser demo).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fluxParseBib = async (text: string) => {
    const Cite = await getCite();
    return (new Cite(text).data as any[]).map(cslToEntry);
  };
}
