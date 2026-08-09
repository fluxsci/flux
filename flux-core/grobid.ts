// OPTIONAL GROBID enrichment. Nothing in Flux depends on this file: it is reached only from the
// `flux grobid` verb, and every artifact it writes is additive. A default install never runs it,
// never mentions it, and behaves identically without it.
//
// GROBID is a local Java service the user (or their agent) sets up per docs/integrations/grobid.qmd. This
// module talks to it over plain HTTP — no client library, no Docker requirement, no bundled
// runtime. When it is not reachable, every entry point returns a diagnosis rather than throwing.
//
// TEI is parsed HERE and nowhere else. Consumers read the flat, versioned projection
// (items/<key>/grobid.json, shape in src/lib/references/grobidDoc.ts) so no other code — least of
// all the renderer — ever touches XML.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFluxLibPath } from "./fluxlib";
import { atomicWrite } from "./fsx";
import {
  GROBID_SCHEMA_VERSION,
  emptyCoverage,
  isCurrent,
  type GrobidCoverage,
  type GrobidDoc,
  type GrobidReference,
  type GrobidSection,
  type GrobidCitation,
} from "../src/lib/references/grobidDoc";

const COVERAGE_REL = path.join(".fluxlib", "grobid.json");
export const DEFAULT_GROBID_URL = "http://localhost:8070";

// linkedom is already a runtime dependency (the plot pipeline uses it headlessly) and parses XML,
// so TEI support costs no new package — which matters under the repo's prebuilt-only posture.
let _DOMParser: any = null;
async function domParser(): Promise<any> {
  if (!_DOMParser) ({ DOMParser: _DOMParser } = await import("linkedom"));
  return new _DOMParser();
}

export interface GrobidStatus {
  url: string;
  reachable: boolean;
  version?: string;
  error?: string;
}

/** Is a GROBID service answering? Never throws — an unreachable service is a normal state that
 *  the caller reports, not an exception. */
export async function grobidStatus(url = DEFAULT_GROBID_URL): Promise<GrobidStatus> {
  try {
    const alive = await fetch(`${url}/api/isalive`, { signal: AbortSignal.timeout(4000) });
    if (!alive.ok) return { url, reachable: false, error: `isalive returned HTTP ${alive.status}` };
    let version: string | undefined;
    try {
      const v = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(4000) });
      if (v.ok) version = ((await v.json()) as any)?.version;
    } catch {
      /* version endpoint is optional */
    }
    return { url, reachable: true, version };
  } catch (e) {
    return { url, reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** POST one PDF and return the TEI. Consolidation is left OFF: it makes GROBID call Crossref per
 *  reference, which is slow, rate-limited, and turns an offline operation into a network one.
 *  Flux already resolves DOIs through its own waterfall. */
async function processPdf(url: string, bytes: Uint8Array, timeoutMs: number): Promise<string> {
  const form = new FormData();
  form.append("input", new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), "paper.pdf");
  form.append("consolidateHeader", "0");
  form.append("consolidateCitations", "0");
  form.append("includeRawCitations", "1");
  const res = await fetch(`${url}/api/processFulltextDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GROBID returned HTTP ${res.status}`);
  const tei = await res.text();
  if (!tei.trimStart().startsWith("<")) throw new Error("GROBID returned a non-XML body");
  return tei;
}

const flat = (el: any): string => (el ? String(el.textContent ?? "").replace(/\s+/g, " ").trim() : "");
const kids = (el: any, name: string): any[] =>
  el ? Array.from(el.children ?? []).filter((c: any) => c.localName === name) : [];

/** "G Girardeau" from <persName><forename>G</forename><surname>Girardeau</surname></persName>.
 *  textContent alone concatenates the parts with no separator ("GGirardeau"), which would make
 *  every parsed author name subtly wrong. */
function personName(pn: any): string {
  if (!pn) return "";
  return [...Array.from(pn.querySelectorAll("forename")), pn.querySelector("surname")]
    .filter(Boolean)
    .map((n: any) => flat(n))
    .filter(Boolean)
    .join(" ");
}

/** TEI → the flat projection. The only XML-aware code in the repo outside the plot pipeline. */
export async function projectTei(tei: string, grobidVersion: string): Promise<GrobidDoc> {
  const doc = (await domParser()).parseFromString(tei, "text/xml");
  const q = (sel: string) => doc.querySelector(sel);
  const qa = (sel: string) => Array.from(doc.querySelectorAll(sel) ?? []);

  const header = q("teiHeader");
  const analytic = header?.querySelector("sourceDesc biblStruct analytic");
  const title = flat(header?.querySelector("titleStmt title")) || undefined;

  const authors = (analytic ? Array.from(analytic.querySelectorAll("author")) : []).flatMap((a: any) => {
    const name = personName(a.querySelector("persName"));
    if (!name) return [];
    const aff = flat(a.querySelector("affiliation orgName")) || undefined;
    return [{ name, affiliation: aff }];
  });

  let docDoi: string | undefined;
  for (const idno of analytic ? Array.from(analytic.querySelectorAll("idno")) : []) {
    if (String((idno as any).getAttribute("type") ?? "").toUpperCase() === "DOI") docDoi = flat(idno);
  }
  const abstract = flat(q("profileDesc abstract")) || undefined;

  // --- body: paragraphs in reading order, then captions, then <back> matter. Offsets recorded as
  // we go so sections and citations can point into the assembled string.
  const body = q("text > body") ?? q("body");
  const parts: string[] = [];
  const sections: GrobidSection[] = [];
  const citations: GrobidCitation[] = [];
  let at = 0;
  // `at` is the END offset of what has been pushed so far. The "\n\n" separator belongs BEFORE a
  // part, not after it — counting it after made every offset drift two characters per part and
  // pushed the final section's end past the end of the body.
  const nextStart = (): number => at + (parts.length ? 2 : 0);
  const push = (s: string): void => {
    if (!s) return;
    if (parts.length) at += 2;
    parts.push(s);
    at += s.length;
  };

  for (const div of body ? kids(body, "div") : []) {
    const start = nextStart();
    const heading = flat(div.querySelector("head")) || undefined;
    for (const p of Array.from(div.querySelectorAll("p"))) {
      const text = flat(p);
      const base = nextStart();
      // Citation offsets are approximate within the paragraph — recorded relative to the
      // paragraph start, which is enough to jump a reader to the right place.
      for (const ref of Array.from((p as any).querySelectorAll("ref"))) {
        if (String((ref as any).getAttribute("type") ?? "") !== "bibr") continue;
        const target = String((ref as any).getAttribute("target") ?? "").replace(/^#?b/, "");
        const n = Number.parseInt(target, 10);
        const label = flat(ref);
        const rel = label ? text.indexOf(label) : -1;
        citations.push({
          at: base + (rel >= 0 ? rel : 0),
          ref: Number.isFinite(n) ? n + 1 : undefined,
          text: label,
        });
      }
      push(text);
    }
    if (at > start) sections.push({ heading, start, end: at });
  }

  const figures = qa("figure");
  let tables = 0;
  for (const f of figures) {
    if (String((f as any).getAttribute("type") ?? "") === "table") tables++;
    push(flat((f as any).querySelector("figDesc")) || flat((f as any).querySelector("head")));
  }
  const back = q("text > back") ?? q("back");
  for (const div of back ? kids(back, "div") : []) {
    if (String((div as any).getAttribute("type") ?? "") === "references") continue;
    push(flat(div));
  }

  const references: GrobidReference[] = [];
  for (const [i, bs] of qa("back listBibl biblStruct").entries()) {
    const el = bs as any;
    let doi: string | undefined;
    for (const idno of Array.from(el.querySelectorAll("idno"))) {
      if (String((idno as any).getAttribute("type") ?? "").toUpperCase() === "DOI") doi = flat(idno);
    }
    const when = el.querySelector("imprint date");
    const journal = Array.from(el.querySelectorAll("monogr title")).find(
      (t: any) => t.getAttribute("level") === "j",
    );
    references.push({
      index: i + 1,
      authors: Array.from(el.querySelectorAll("author persName")).map((pn: any) => personName(pn)).filter(Boolean),
      title: flat(el.querySelector("analytic title")) || flat(el.querySelector("monogr title")) || undefined,
      journal: flat(journal) || undefined,
      year: (when?.getAttribute?.("when") as string) || flat(when) || undefined,
      doi,
      raw: flat(el.querySelector("note[type='raw_reference']")) || undefined,
    });
  }

  const linked = citations.filter((c) => c.ref !== undefined).length;
  return {
    schemaVersion: GROBID_SCHEMA_VERSION,
    grobidVersion,
    extractedAt: new Date().toISOString(),
    title,
    authors,
    abstract,
    doi: docDoi,
    body: parts.join("\n\n"),
    sections,
    references,
    citations,
    counts: {
      references: references.length,
      referencesWithDoi: references.filter((r) => r.doi).length,
      citations: citations.length,
      citationsLinked: linked,
      figures: figures.length,
      tables,
    },
  };
}

async function readCoverage(lib: string): Promise<GrobidCoverage> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lib, COVERAGE_REL), "utf8")) as GrobidCoverage;
    if (parsed?.items && typeof parsed.items === "object") return parsed;
  } catch {
    /* absent or corrupt → start clean; it is derived data */
  }
  return emptyCoverage();
}

async function writeCoverage(lib: string, cov: GrobidCoverage): Promise<void> {
  cov.updatedAt = new Date().toISOString();
  await atomicWrite(path.join(lib, COVERAGE_REL), JSON.stringify(cov, null, 1) + "\n");
}

/** Read one item's enrichment, or null. THE accessor every optional consumer should use: it must
 *  never throw, so a feature can simply ask and light up only when there is an answer. */
export async function readGrobidDoc(key: string, libPath?: string): Promise<GrobidDoc | null> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  try {
    const raw = await fs.readFile(path.join(lib, "items", key, "grobid.json"), "utf8");
    const doc = JSON.parse(raw) as GrobidDoc;
    return doc?.schemaVersion === GROBID_SCHEMA_VERSION ? doc : null;
  } catch {
    return null;
  }
}

export interface GrobidRunOptions {
  url?: string;
  libPath?: string;
  /** Re-enrich items already current (e.g. after a GROBID upgrade). */
  force?: boolean;
  /** Re-derive grobid.json from the STORED TEI. No service needed, seconds not minutes. */
  reproject?: boolean;
  keys?: string[];
  limit?: number;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export interface GrobidRunReport {
  url: string;
  grobidVersion: string;
  processed: string[];
  skipped: string[];
  failed: { key: string; error: string }[];
  totalWithPdf: number;
  elapsedMs: number;
  /** Set when the service was unreachable — the caller prints the setup pointer. */
  unavailable?: string;
}

/** Enrich the library. Incremental and resumable: items already current are skipped, each item is
 *  written as it completes, and the coverage ledger is persisted as we go so an interrupted run
 *  resumes rather than restarts. */
export async function grobidEnrich(opts: GrobidRunOptions = {}): Promise<GrobidRunReport> {
  const t0 = Date.now();
  const lib = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const url = opts.url ?? DEFAULT_GROBID_URL;
  const itemsDir = path.join(lib, "items");
  const report: GrobidRunReport = {
    url,
    grobidVersion: "",
    processed: [],
    skipped: [],
    failed: [],
    totalWithPdf: 0,
    elapsedMs: 0,
  };

  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(itemsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    report.elapsedMs = Date.now() - t0;
    return report;
  }
  if (opts.keys?.length) {
    const want = new Set(opts.keys.map((k) => k.normalize("NFC")));
    dirs = dirs.filter((d) => want.has(d.normalize("NFC")));
  }

  const cov = await readCoverage(lib);
  let version = "";
  if (!opts.reproject) {
    const st = await grobidStatus(url);
    if (!st.reachable) {
      report.unavailable = st.error ?? "not reachable";
      report.elapsedMs = Date.now() - t0;
      return report;
    }
    version = st.version ?? "unknown";
  }
  report.grobidVersion = version;

  let done = 0;
  for (const key of dirs.sort()) {
    const pdf = path.join(itemsDir, key, "paper.pdf");
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(pdf)).mtimeMs;
    } catch {
      continue; // metadata-only entry — nothing to enrich
    }
    report.totalWithPdf++;
    if (opts.limit && done >= opts.limit) continue;

    const teiPath = path.join(itemsDir, key, "grobid.tei.xml");
    if (opts.reproject) {
      // Re-derive the projection from stored TEI. Skips anything never enriched.
      let tei: string;
      try {
        tei = await fs.readFile(teiPath, "utf8");
      } catch {
        continue;
      }
      try {
        const prev = cov.items[key];
        const projected = await projectTei(tei, prev?.grobidVersion ?? "unknown");
        await atomicWrite(path.join(itemsDir, key, "grobid.json"), JSON.stringify(projected, null, 1) + "\n");
        cov.items[key] = {
          ok: true,
          schemaVersion: GROBID_SCHEMA_VERSION,
          grobidVersion: projected.grobidVersion,
          extractedAt: prev?.extractedAt ?? projected.extractedAt,
          pdfMtimeMs: mtimeMs,
          references: projected.counts.references,
          citationsLinked: projected.counts.citationsLinked,
        };
        report.processed.push(key);
        done++;
      } catch (e) {
        report.failed.push({ key, error: e instanceof Error ? e.message : String(e) });
      }
      continue;
    }

    if (!opts.force && isCurrent(cov.items[key], mtimeMs)) {
      report.skipped.push(key);
      continue;
    }
    try {
      const bytes = new Uint8Array(await fs.readFile(pdf));
      const tei = await processPdf(url, bytes, opts.timeoutMs ?? 600_000);
      await atomicWrite(teiPath, tei);
      const projected = await projectTei(tei, version);
      await atomicWrite(path.join(itemsDir, key, "grobid.json"), JSON.stringify(projected, null, 1) + "\n");
      cov.items[key] = {
        ok: true,
        schemaVersion: GROBID_SCHEMA_VERSION,
        grobidVersion: version,
        extractedAt: projected.extractedAt,
        pdfMtimeMs: mtimeMs,
        references: projected.counts.references,
        citationsLinked: projected.counts.citationsLinked,
      };
      report.processed.push(key);
      opts.onProgress?.(`${key}: ${projected.counts.references} refs, ${projected.counts.citationsLinked} linked`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      cov.items[key] = {
        ok: false,
        schemaVersion: GROBID_SCHEMA_VERSION,
        grobidVersion: version,
        extractedAt: new Date().toISOString(),
        pdfMtimeMs: mtimeMs,
        error,
      };
      report.failed.push({ key, error });
      opts.onProgress?.(`${key}: FAILED — ${error}`);
    }
    done++;
    if (done % 25 === 0) await writeCoverage(lib, cov);
  }

  await writeCoverage(lib, cov);
  report.elapsedMs = Date.now() - t0;
  return report;
}

export interface GrobidStatusReport extends GrobidStatus {
  enriched: number;
  stale: number;
  failed: number;
  never: number;
  totalWithPdf: number;
  references: number;
  citationsLinked: number;
  schemaVersion: number;
}

/** What is enriched, what is stale, and is a service available. Reads only the ledger + stats. */
export async function grobidCoverageReport(opts: { url?: string; libPath?: string } = {}): Promise<GrobidStatusReport> {
  const lib = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const st = await grobidStatus(opts.url ?? DEFAULT_GROBID_URL);
  const cov = await readCoverage(lib);
  const itemsDir = path.join(lib, "items");
  let enriched = 0, stale = 0, failed = 0, never = 0, total = 0, refs = 0, cites = 0;
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(itemsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no items yet */
  }
  for (const key of dirs) {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(path.join(itemsDir, key, "paper.pdf"))).mtimeMs;
    } catch {
      continue;
    }
    total++;
    const rec = cov.items[key];
    if (!rec) never++;
    else if (!rec.ok) failed++;
    else if (!isCurrent(rec, mtimeMs)) stale++;
    else {
      enriched++;
      refs += rec.references ?? 0;
      cites += rec.citationsLinked ?? 0;
    }
  }
  return {
    ...st,
    enriched,
    stale,
    failed,
    never,
    totalWithPdf: total,
    references: refs,
    citationsLinked: cites,
    schemaVersion: GROBID_SCHEMA_VERSION,
  };
}
