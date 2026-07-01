// Loads the project's cited-subset bibliography and grows the machine-global
// FluxLib. loadBib() reads references/library.bib (the fast, in-memory editor
// path — unchanged). Adding a reference (pasted DOI / Cmd-K) now writes to FluxLib
// (deduped by DOI, deterministic citekey) and materializes the entry into this
// project's library.bib. Parsing/citekey/dedup live in the shared references
// module so the GUI and flux-core stay in lockstep.

import { fileBridge, joinPath } from "../../../../lib/project/types";
import { bibEntries, bibError, type BibEntry } from "./bib";
import { bumpBibRevision } from "../../../scholar/revisions";
import { getCite, cslToEntry } from "../../../../lib/references/bibtex";
import { addToFluxLib, materializeIntoProject } from "../../../../lib/references/fluxlibBridge";

const BIB_PATH = ["references", "library.bib"];

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Parse `references/library.bib` (the project's cited subset) into the bib store.
 *  Safe no-op without a project. */
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
  // A comment-only / whitespace-only .bib is valid BibLaTeX with zero entries
  // (this is exactly the freshly-materialized project bib: just the `% …` header).
  // Citation.js throws "format not recognized" on such input, so short-circuit
  // before parsing — no entries, no error.
  const atCount = (text.match(/^[ \t]*@/gm) ?? []).length;
  if (!text.trim() || atCount === 0) {
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

/** Build a BibEntry (no key yet — FluxLib assigns it) from CrossRef metadata. */
function msgToEntry(msg: any, fallbackDoi?: string): BibEntry {
  const doi = msg.DOI || fallbackDoi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  return {
    key: "",
    title: first<string>(msg.title) ?? "",
    authors: crossrefAuthors(msg)
      .map((a) => a.family)
      .filter(Boolean),
    year: crossrefYear(msg),
    container: first<string>(msg["container-title"]) || undefined,
    doi: doi || undefined,
    url: msg.URL || undefined,
  };
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

/** Fetch a DOI's CrossRef metadata and turn it into a BibTeX string (temp key). */
async function doiToBibtex(
  doi: string,
): Promise<{ bibtex: string; entry: BibEntry } | { error: string }> {
  const fb = fileBridge();
  if (!fb?.fetchDoi) return { error: "DOI lookup needs the desktop app." };
  const res = await fb.fetchDoi(doi);
  if (!res || res.error || !res.message) return { error: res?.error || "Not found" };
  const msg = res.message as any;
  const entry = msgToEntry(msg, doi);
  return { bibtex: toBibtex("ref", msg, entry), entry };
}

/**
 * Fetch a DOI, add it to FluxLib (deterministic citekey, deduped by DOI), and
 * materialize it into this project's library.bib. Returns the entry to cite.
 */
export async function addDoiToBib(
  doi: string,
  root: string | null,
): Promise<BibEntry | { error: string }> {
  const built = await doiToBibtex(doi);
  if ("error" in built) return built;
  const r = await addToFluxLib(built.bibtex, { source: "doi" });
  const key = r.keys[0];
  if (!key) return { error: "Could not add the reference to FluxLib." };
  const entry: BibEntry = { ...built.entry, key };

  if (root) await materializeIntoProject(root, [key]);
  bibEntries.update((list) => (list.some((e) => e.key === key) ? list : [...list, entry]));
  // WS6: provenance for the human's reference add (Electron only).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "cite", target: key, client: "human" });
  bumpBibRevision();
  return entry;
}

/**
 * Fetch a DOI and add it to FluxLib ONLY (no project cite) — backs the Cmd-K
 * "Add DOI to FluxLib" command. Returns the resolved citekey + title.
 */
export async function addDoiToLibrary(
  doi: string,
): Promise<{ key: string; title: string } | { error: string }> {
  const built = await doiToBibtex(doi);
  if ("error" in built) return built;
  const r = await addToFluxLib(built.bibtex, { source: "doi" });
  const key = r.keys[0];
  if (!key) return { error: "Could not add the reference to FluxLib." };
  return { key, title: built.entry.title };
}

/**
 * Resolve a DOI *or* a paper URL to a DOI. Bare DOIs and doi.org links normalize
 * locally (no fetch); any other URL is handed to the main process to fetch + scrape
 * its citation metadata. Backs the URL-aware add paths below + web capture.
 */
export async function resolveToDoi(
  input: string,
): Promise<{ doi: string } | { error: string }> {
  const raw = input.trim();
  if (!raw) return { error: "Paste a DOI or URL." };
  const bare = raw.replace(/^\s*doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  if (/^10\.\d{4,9}\/\S+$/i.test(bare)) return { doi: bare.replace(/[)\]>.,;'"]+$/, "") };
  if (/^https?:\/\//i.test(raw)) {
    const fb = fileBridge();
    if (!fb?.resolveUrl) return { error: "Resolving a URL needs the desktop app — paste a DOI instead." };
    const r = await fb.resolveUrl(raw);
    if (r?.doi) return { doi: r.doi };
    return { error: r?.error || "Couldn't find a DOI on that page." };
  }
  return { error: "Enter a DOI (10.xxxx/…) or a paper URL." };
}

/** Resolve a DOI/URL and add it to FluxLib only (Library paste box + web capture). */
export async function addUrlOrDoiToLibrary(
  input: string,
): Promise<{ key: string; title: string } | { error: string }> {
  const r = await resolveToDoi(input);
  if ("error" in r) return r;
  return addDoiToLibrary(r.doi);
}

/** Resolve a DOI/URL, add it to FluxLib, and materialize it into this project. */
export async function addUrlOrDoiToBib(
  input: string,
  root: string | null,
): Promise<BibEntry | { error: string }> {
  const r = await resolveToDoi(input);
  if ("error" in r) return r;
  return addDoiToBib(r.doi, root);
}

// Dev probe: verify Citation.js loads + parses in the real Vite/browser env
// (the file-bridge path can't run in the browser demo).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fluxParseBib = async (text: string) => {
    const Cite = await getCite();
    return (new Cite(text).data as any[]).map(cslToEntry);
  };
}
