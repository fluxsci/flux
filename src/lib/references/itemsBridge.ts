import { itemKey } from "./itemLocator";
import { recoverItemPublication, type ItemRecoveryResult } from "./itemRecovery";
import { withIpcLock } from "./libLock";
// Renderer-side access to the FluxLib items/ store (the browser/Electron twin of
// flux-core/items.ts) — reads a stored PDF's bytes / provenance over window.fig.
// Reuses the pure path helpers (items.ts) + the resolved FluxLib path.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import {
  itemDir,
  itemsBase,
  pdfPath,
  linkPath,
  parsePdfLink,
  fulltextPath,
  sourcePath,
  failurePath,
  safeKey,
  readerContextPath,
  oaMissesPath,
  supplementsDir,
  supplementFilePath,
  supplementManifestPath,
  safeSupplementName,
  parseSupplementManifest,
  type SupplementManifest,
  type SupplementRecord,
  PAPER_PDF,
  PAPER_LINK,
  FETCH_FAILURE_JSON,
  type PdfLink,
  type SourceInfo,
  type FetchFailure,
  type ReaderContext,
  type OaMissMap,
  type OaMissFile,
} from "./items";
import { isPdfBytes } from "./pdfFinder";
import { isSupplementUrl, supplementDocSignal, supplementNameFromUrl, isAutomatedSource } from "./supplement";
import { seededItem, seededSupplements, seededKeys } from "./devSeed";
import { pushToast } from "../toast";

/**
 * Outcome of filing a fetched PDF. `ok: false, reason: "supplement"` is NOT an error — it
 * means the bytes were supplementary material, they have been filed under supplements/,
 * and the caller should carry on looking for the actual article.
 */
export type PdfWriteResult =
  | { ok: true }
  | { ok: false; reason: "no-bridge" | "already-present" }
  | { ok: false; reason: "supplement"; signal: string; divertedTo?: string };

async function pdfIdentity(lib: string, key: string): Promise<string | null> {
  const fb = fileBridge(); if (!fb) return null;
  let target = pdfPath(lib, key);
  if (!await fb.exists(target)) {
    if (!await fb.exists(linkPath(lib, key))) return null;
    const link = parsePdfLink(await fb.readText(linkPath(lib, key))); if (!link) return null;
    target = link.path;
  }
  if (!await fb.exists(target)) return null;
  const stat = await fb.stat?.(target);
  return stat ? JSON.stringify({path: target.replace(/\\/g, "/"), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs}) : target;
}
async function writeExtracted(lib: string, key: string, text: string, identity: string | null): Promise<boolean> {
  const fb = fileBridge(); if (!fb) return false;
  return withIpcLock("fluxlib", `item-${safeKey(key)}`, async lease => {
    if (await fb.exists(`${itemDir(lib,key)}/source.pending.json`) || identity !== await pdfIdentity(lib, key)) return false;
    await lease.assertOwned?.();
    await fb.writeText(`${itemDir(lib, key)}/fulltext.source.json`, JSON.stringify({version: 1, identity}) + "\n");
    await lease.assertOwned?.();
    await fb.writeText(fulltextPath(lib, key), text); return true;
  });
}
/** Manual ingest has no size ceiling (unlike netGet's 80MB fetch cap) — warn on huge
 *  scans so the memory cost of opening them isn't a surprise. Never blocks the ingest. */
function warnHugePdf(bytes: Uint8Array, what: string): void {
  const MB = 1024 * 1024;
  if (bytes.length > 80 * MB) {
    pushToast("info", `That ${what} is ${Math.round(bytes.length / MB)}MB`, {
      detail: "It will open, but the reader holds the whole file in memory while it's open — very large scans read slowly.",
    });
  }
}

/** Stable source identity for Reader reloads, including in-place external PDF changes. */
export async function readerPdfIdentity(key: string): Promise<string | null> {
  const seeded=seededItem(key);if(seeded)return `seeded:${seeded.pdf.byteLength}`;
  const lib=await resolveFluxLibPath();return lib?pdfIdentity(lib,key):null;
}

/** File a hand-downloaded PDF (chosen via the OS picker) into items/<key>/ — the manual
 *  fallback for paywalled papers. Validates the %PDF- header. Returns false if the file
 *  isn't a PDF or can't be read. */
export async function ingestPdfFile(key: string, filePath: string): Promise<boolean> {
  const fb = fileBridge();
  if (!fb) return false;
  let buf: ArrayBuffer | null;
  try {
    buf = await fb.readFile(filePath);
  } catch {
    return false;
  }
  if (!buf) return false;
  const bytes = new Uint8Array(buf);
  if (!isPdfBytes(bytes)) return false;
  warnHugePdf(bytes, "PDF");
  return (await writePdfItem(key, bytes, { source: "ingest", url: filePath, finalUrl: filePath })).ok;
}

/** The set of citekeys (safeKey form) that have a paper.pdf on disk — one readdir of
 *  items/ + a presence check per item dir (scales with fetched papers, not library
 *  size). Used by the Library to show a "has PDF" pill and gate the "Read" action. */
export async function listPdfKeys(expectedLib?: string | null): Promise<Set<string>> {
  const fb = fileBridge();
  const lib = expectedLib === undefined ? await resolveFluxLibPath() : expectedLib;
  const out = new Set<string>();
  // Dev-seeded items ARE the item store in headless runs (readerPdfBytes consults the
  // same map first); empty in production, so this is a no-op there.
  for (const k of seededKeys()) out.add(safeKey(k).normalize("NFC"));
  if (!fb || !lib) return out;
  // Child artifact changes do not update items/' parent mtime. Presence is
  // checked against actual files; the old derived index is not authoritative.
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out; // no items/ yet
  }
  const dirs = entries.filter(e => e.dir);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(12, dirs.length)}, async () => {
    while (next < dirs.length) {
      const {name} = dirs[next++];
      const key = itemKey(lib, name);
      if (await pdfIdentity(lib, key)) out.add(key.normalize("NFC"));
    }
  }));
  return out;
}

/** True if `key`'s PDF dir-name is in a set produced by listPdfKeys(). NFC-normalized so
 *  the join is Unicode-normalization-invariant (see listPdfKeys). */
export const hasPdfIn = (pdfKeys: Set<string>, key: string): boolean =>
  pdfKeys.has(key.normalize("NFC")) || pdfKeys.has(safeKey(key).normalize("NFC"));

/** File a fetched PDF into items/<key>/ + write source.json provenance (renderer twin
 *  of flux-core writePdf). Computes a SHA-256 via WebCrypto for parity, and extracts
 *  fulltext.txt best-effort — this is the ONE place every GUI acquisition path funnels
 *  through (bulk fetch, proxy capture, manual ingest, assign), so GUI-acquired papers
 *  are full-text-searchable exactly like Node-acquired ones. */
export async function writePdfItem(
  key: string,
  bytes: Uint8Array,
  info: { source: string; url?: string; finalUrl?: string; isOa?: boolean; license?: string; replaceExisting?: boolean; ifAbsent?: boolean },
): Promise<PdfWriteResult> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return { ok: false, reason: "no-bridge" };
  // Gate every AUTOMATED acquisition on "is this actually the article?" before it can become
  // paper.pdf. Doing this at the write point rather than inside one fetch route is deliberate:
  // it covers the OA waterfall, the proxy capture and any future route at once, and it is the
  // check that catches a supplement whose URL looked innocent on the way in. A supplement
  // isn't discarded — it's filed where it belongs, and the caller is told to keep looking.
  if (isAutomatedSource(info.source)) {
    const signal = await classifyAcquiredPdf(bytes, info.finalUrl ?? info.url);
    if (signal) {
      const divertedTo = await fileSupplementBytes(key, supplementNameFromUrl(info.finalUrl ?? info.url) || "supplement.pdf", bytes, {
        url: info.finalUrl ?? info.url,
        source: info.source,
      });
      return { ok: false, reason: "supplement", signal, divertedTo: divertedTo ?? undefined };
    }
  }
  let sha256: string | undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    /* WebCrypto unavailable — provenance still useful without the hash */
  }
  const source: SourceInfo = {
    key,
    source: info.source,
    url: info.url,
    finalUrl: info.finalUrl,
    fetchedAt: new Date().toISOString(),
    sha256,
    bytes: bytes.length,
    isOa: info.isOa,
    license: info.license,
  };
  let identity: string | null = null;
  const published = await withIpcLock("fluxlib", `item-${safeKey(key)}`, async lease => {
    if ((isAutomatedSource(info.source) || info.source === "assigned" || info.ifAbsent) && !info.replaceExisting && await pdfIdentity(lib, key)) return false;
    if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
    const pending = `${itemDir(lib, key)}/source.pending.json`;
    await lease.assertOwned?.();
    await fb.writeText(pending, JSON.stringify({version: 1, source}) + "\n");
    for (const path of [fulltextPath(lib, key), `${itemDir(lib, key)}/fulltext.source.json`]) {
      if (await fb.exists(path)) { if (!fb.remove) throw new Error("Cannot invalidate prior PDF text"); await lease.assertOwned?.(); await fb.remove(path); }
    }
    await lease.assertOwned?.();
    await fb.writeFile(pdfPath(lib, key), bytes);
    await lease.assertOwned?.();
    await fb.writeText(sourcePath(lib, key), JSON.stringify(source, null, 2) + "\n");
    identity = await pdfIdentity(lib, key);
    await lease.assertOwned?.();
    await fb.remove?.(pending);
    return true;
  });
  if (!published) return {ok: false, reason: "already-present"};
  // Fulltext parity with flux-core attach/acquire (dynamic import keeps pdf.js out of
  // the Library chunk until a PDF actually lands; scanned PDFs simply yield no text).
  try {
    const { extractFulltextText } = await import("../pdf/pdfFulltext");
    const ft = await extractFulltextText(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
    if (ft.chars > 0) await writeExtracted(lib, key, ft.text, identity);
  } catch {
    /* best-effort — paper.pdf is filed regardless */
  }
  return { ok: true };
}

/** The link-mode pointer for `key`, or null (absent/malformed). */
export async function readerPdfLink(key: string): Promise<PdfLink | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    return parsePdfLink(await fb.readText(linkPath(lib, key)));
  } catch {
    return null;
  }
}

/** Read a stored PDF's bytes (ArrayBuffer) for the reader, or null if absent.
 *  A stored paper.pdf wins; else a link-mode pointer (Zotero sync `attach: "link"`)
 *  resolves to the external file — a moved/deleted external copy degrades to null
 *  ("PDF missing"), never a scattered error. */
export async function readerPdfBytes(key: string): Promise<ArrayBuffer | null> {
  const s = seededItem(key);
  if (s) return s.pdf.slice().buffer; // headless harness fixture (devSeed.ts)
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  await recoverPdfItem(key);
  const p = pdfPath(lib, key);
  try {
    if (await fb.exists(p)) return await fb.readFile(p);
  } catch {
    return null;
  }
  const link = await readerPdfLink(key);
  if (!link) return null;
  try {
    const identity = await pdfIdentity(lib, key);
    const buf = await fb.readFile(link.path);
    // Deferred-fulltext backfill: a linked paper whose text extraction was skipped at
    // sync time (huge-library posture) gets it now, opportunistically — we have the
    // bytes anyway. Fire-and-forget; the reader never waits on it.
    const extractionBytes = new Uint8Array(buf.slice(0)); // before returning: PDF.js transfers the reader buffer
    void (async () => {
      try {
        if (await fb.exists(fulltextPath(lib, key))) {
          try { if (JSON.parse(await fb.readText(`${itemDir(lib, key)}/fulltext.source.json`)).identity === identity) return; } catch { /* legacy linked text needs a source generation */ }
        }
        const { extractFulltextText } = await import("../pdf/pdfFulltext");
        const ft = await extractFulltextText(extractionBytes);
        if (ft.chars > 0) await writeExtracted(lib, key, ft.text, identity);
      } catch {
        /* best-effort */
      }
    })();
    return buf;
  } catch {
    return null;
  }
}

export async function readerHasPdf(key: string): Promise<boolean> {
  if (seededItem(key)) return true;
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  try {
    return !!await pdfIdentity(lib, key);
  } catch {
    return false;
  }
}

/** Link-mode attach (renderer twin of flux-core writeLinkedPdf + the fulltext parity
 *  of writePdfItem): record a pointer to the external PDF, write provenance, and —
 *  when the caller has the bytes in hand — extract fulltext so search works without
 *  a stored copy. `bytes` is ABSENT on a deferred attach (huge libraries: the sync
 *  never reads the linked file; text backfills lazily on first reader open /
 *  getOrExtractFulltext). */
export async function writeLinkedPdfItem(key: string, absPath: string, bytes?: Uint8Array): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  if (await fb.exists(pdfPath(lib, key))) return true;
  let identity: string | null = null;
  await withIpcLock("fluxlib", `item-${safeKey(key)}`, async lease => {
    if (await fb.exists(pdfPath(lib,key))) return;
    const link: PdfLink = {path: absPath, linkedAt: new Date().toISOString()};
    const source: SourceInfo = {key, source: "zotero-link", url: absPath, fetchedAt: link.linkedAt, bytes: bytes?.length};
    const previousLink=await fb.exists(linkPath(lib,key))?await fb.readText(linkPath(lib,key)):null;
    const pending=`${itemDir(lib,key)}/source.pending.json`;
    await lease.assertOwned?.();await fb.writeText(pending,JSON.stringify({version:1,source,link,previousLink})+"\n");
    if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
    for (const path of [fulltextPath(lib, key), `${itemDir(lib, key)}/fulltext.source.json`]) {
      if (await fb.exists(path)) { if (!fb.remove) throw new Error("Cannot invalidate prior PDF text"); await lease.assertOwned?.(); await fb.remove(path); }
    }
    await lease.assertOwned?.();
    await fb.writeText(linkPath(lib, key), JSON.stringify(link, null, 2) + "\n");
    await lease.assertOwned?.();
    await fb.writeText(sourcePath(lib, key), JSON.stringify(source, null, 2) + "\n");
    identity = await pdfIdentity(lib, key);
    await lease.assertOwned?.();await fb.remove?.(pending);
  });
  if (bytes) {
    try {
      const { extractFulltextText } = await import("../pdf/pdfFulltext");
      const ft = await extractFulltextText(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
      if (ft.chars > 0) await writeExtracted(lib, key, ft.text, identity);
    } catch {
      /* best-effort — the pointer is filed regardless */
    }
  }
  return true;
}

/** Recover only content-proven interrupted publications; ordinary reads stay cheap. */
export async function recoverPdfItem(key: string): Promise<ItemRecoveryResult> {
  const fb=fileBridge(),lib=await resolveFluxLibPath();if(!fb||!lib)return "none";
  const dir=itemDir(lib,key);if(!await fb.exists(`${dir}/source.pending.json`))return "none";
  return withIpcLock("fluxlib",`item-${safeKey(key)}`,lease=>recoverItemPublication(key,{
    readText:async name=>await fb.exists(`${dir}/${name}`)?await fb.readText(`${dir}/${name}`):null,
    pdfSha256:async()=>{if(!await fb.exists(pdfPath(lib,key)))return null;const bytes=await fb.readFile(pdfPath(lib,key));const hash=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");},
    writeText:(name,text)=>fb.writeText(`${dir}/${name}`,text),
    remove:async name=>{if(await fb.exists(`${dir}/${name}`)){if(!fb.remove)throw new Error("PDF recovery requires file removal");await fb.remove(`${dir}/${name}`);}},
    assertOwned:async()=>{await lease.assertOwned?.();},
  }));
}

export async function readerSource(key: string): Promise<SourceInfo | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    await recoverPdfItem(key);
    return JSON.parse(await fb.readText(sourcePath(lib, key))) as SourceInfo;
  } catch {
    return null;
  }
}

// --- supplements (items/<key>/supplements/) --------------------------------------
// Optional supplementary PDFs the reader's "Switch PDF" dropdown lists beside paper.pdf.
// The folder is populated by hand (attach), the mis-stored-supplement repair, or a future
// auto-capture — never required for a paper to be readable.

/** List the supplement PDFs for `key` (bare filenames, sorted). Empty if the folder is
 *  absent. Only .pdf files are returned — the reader can only display PDFs. */
export async function listSupplements(key: string): Promise<string[]> {
  const s = seededSupplements(key);
  if (s) return [...s.keys()].sort((a, b) => a.localeCompare(b)); // headless harness fixture
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib || !fb.readdir) return [];
  try {
    const ents = await fb.readdir(supplementsDir(lib, key));
    return ents
      .filter((e) => !e.dir && /\.pdf$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return []; // no supplements/ folder
  }
}

/** Read a supplement PDF's bytes for the reader, or null if absent. `name` is a bare
 *  filename (re-sanitized to stay inside the folder). */
export async function readerSupplementBytes(key: string, name: string): Promise<ArrayBuffer | null> {
  const seed = seededSupplements(key)?.get(name);
  if (seed) return seed.slice().buffer; // headless harness fixture
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  const p = supplementFilePath(lib, key, name);
  try {
    return (await fb.exists(p)) ? await fb.readFile(p) : null;
  } catch {
    return null;
  }
}

/** Read the labelled supplement index for `key` (empty when absent — it's advisory).
 *  Short-circuits under the headless harness for the same reason listSupplements does:
 *  the seeded fixture has no FluxLib, and awaiting resolveFluxLibPath() there never
 *  settles — which would leave the reader stuck on "Loading…" forever. */
export async function readSupplementManifest(key: string): Promise<SupplementManifest> {
  if (seededSupplements(key)) return { version: 1, items: [] };
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return { version: 1, items: [] };
  try {
    return parseSupplementManifest(await fb.readText(supplementManifestPath(lib, key)));
  } catch {
    return { version: 1, items: [] };
  }
}

/** Upsert one supplement's record by filename, newest wins. Best-effort: a manifest write
 *  failure must never lose the file itself, which is already on disk. */
async function recordSupplement(key: string, rec: SupplementRecord, assertOwned?: () => Promise<void>): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  try {
    const m = await readSupplementManifest(key);
    const items = m.items.filter((r) => r.name !== rec.name);
    items.push(rec);
    items.sort((a, b) => a.name.localeCompare(b.name));
    await assertOwned?.();
    await fb.writeText(supplementManifestPath(lib, key), JSON.stringify({ version: 1, items }, null, 2) + "\n");
  } catch (error) { throw new Error(`Supplement ${rec.name} was saved, but its metadata could not be committed`, {cause: error}); }
}

/**
 * File already-in-hand bytes into items/<key>/supplements/ and index them.
 * This is the shared landing point for every supplement Flux acquires: the capture engine's
 * supplement pass, the Europe PMC ZIP, and the write-time diversion of a supplement that was
 * about to be stored as paper.pdf. Returns the stored filename (suffixed -2, -3, … so nothing
 * is overwritten), or null if it couldn't be written.
 */
export async function fileSupplementBytes(key: string, rawName: string, bytes: Uint8Array, meta: {label?: string; url?: string; source?: string} = {}): Promise<string | null> {
  return withIpcLock("fluxlib", `item-${safeKey(key)}`, lease => fileSupplementBytesLocked(key, rawName, bytes, meta, lease.assertOwned));
}
async function fileSupplementBytesLocked(
  key: string,
  rawName: string,
  bytes: Uint8Array,
  meta: { label?: string; url?: string; source?: string } = {},
  assertOwned?: () => Promise<void>,
): Promise<string | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib || !bytes.length) return null;
  if (fb.mkdir) await fb.mkdir(supplementsDir(lib, key));
  let name = safeSupplementName(rawName || "supplement.pdf");
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  // A byte-identical file already filed under this name is the same supplement re-fetched —
  // keep one copy rather than accumulating -2, -3, … across repeated bulk runs.
  let sha256: string | undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    /* hash is provenance-only */
  }
  if (sha256) {
    const existing = (await readSupplementManifest(key)).items.find((r) => r.sha256 === sha256);
    if (existing && (await fb.exists(supplementFilePath(lib, key, existing.name)))) return existing.name;
  }
  // The manifest is advisory and may be absent or predate hashing (files put here by the
  // repair, or by an older Flux), so the DISK is the authority: before suffixing a name,
  // check whether what's already there is byte-identical. Without this, every re-fetch of an
  // unindexed supplement lays down another -2, -3, … copy.
  let alreadySaved = false;
  for (let i = 2; await fb.exists(supplementFilePath(lib, key, name)); i++) {
    if (sha256) {
      try {
        const cur = new Uint8Array((await fb.readFile(supplementFilePath(lib, key, name))) as ArrayBuffer);
        const d = await crypto.subtle.digest("SHA-256", cur as unknown as ArrayBuffer);
        if ([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("") === sha256) { alreadySaved = true; break; }
      } catch {
        /* unreadable — fall through and pick the next free name */
      }
    }
    name = `${base}-${i}${ext}`;
  }
  try {
    if (!alreadySaved) { await assertOwned?.(); await fb.writeFile(supplementFilePath(lib, key, name), bytes); }
  } catch {
    return null;
  }
  await recordSupplement(key, { name, label: meta.label || undefined, url: meta.url, source: meta.source, bytes: bytes.length, sha256, fetchedAt: new Date().toISOString() }, assertOwned);
  return name;
}

/**
 * Is this freshly-acquired PDF actually the article, or its supplementary material?
 * Returns a short reason string when it is NOT the article, else null.
 *
 * Two independent layers, cheapest first: the URL it finally came from, then the document's
 * own opening. The content layer matters because the URL layer is pattern-matching against
 * publisher HTML, which has no floor — that is exactly how the Science supplement got stored
 * as paper.pdf twice. See notes/Flux_Supplement_Capture_Report.md.
 */
export async function classifyAcquiredPdf(bytes: Uint8Array, finalUrl?: string): Promise<string | null> {
  if (finalUrl && isSupplementUrl(finalUrl)) return "supplement-url";
  try {
    const { extractPdfSignals } = await import("../pdf/pdfSignals");
    const s = await extractPdfSignals(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
    return supplementDocSignal({ title: s.xmpTitle ?? s.infoTitle, page1Text: s.page1Text });
  } catch {
    return null; // extraction failed — don't block a write on a parse error
  }
}

/** Copy a hand-picked PDF into items/<key>/supplements/. Validates the %PDF header. Returns
 *  the stored filename (suffixed -2, -3, … on a name collision so nothing is overwritten),
 *  or null if the file isn't a readable PDF. */
export async function ingestSupplementFile(key: string, filePath: string): Promise<string | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  let buf: ArrayBuffer | null;
  try {
    buf = await fb.readFile(filePath);
  } catch {
    return null;
  }
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  if (!isPdfBytes(bytes)) return null;
  warnHugePdf(bytes, "supplement");
  let name = safeSupplementName(filePath);
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  return fileSupplementBytes(key, name, bytes, {source:"ingest",url:filePath});
}

// --- OA-miss ledger (single aggregated file — see items.ts) ----------------------

/** Load the OA-miss ledger (one read). Missing/corrupt file → empty map. */
export async function loadOaMisses(): Promise<OaMissMap> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return {};
  try {
    const p = oaMissesPath(lib);
    if (!(await fb.exists(p))) return {};
    const parsed = JSON.parse(await fb.readText(p)) as OaMissFile;
    return parsed && typeof parsed.misses === "object" && parsed.misses ? parsed.misses : {};
  } catch {
    return {};
  }
}

/** Persist the OA-miss ledger. Best-effort (a lost save just means a re-check later). */
export async function saveOaMisses(misses: OaMissMap): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  try {
    if (fb.mkdir) await fb.mkdir(`${lib}/.fluxlib`);
    const file: OaMissFile = { version: 1, misses };
    await fb.writeText(oaMissesPath(lib), JSON.stringify(file, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

// --- fetch-failure log (Part C) -------------------------------------------------
// Records WHY a paper couldn't be fetched after exhausting every route, so the bulk run
// skips it by default (no re-grinding the same DOI) and the user can see/diagnose the
// backlog. Cleared on any later success. Never written for environment failures.

/** Record (or increment) a paper's fetch failure. Merges with any prior record so
 *  `attempts` accumulates across runs. Best-effort; returns false if it couldn't write. */
export async function writeFetchFailure(
  key: string,
  rec: Omit<FetchFailure, "key" | "attempts" | "attemptedAt"> & { attemptedAt?: string },
): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  const prior = await readFetchFailure(key);
  const full: FetchFailure = {
    key,
    target: rec.target,
    host: rec.host ?? prior?.host,
    attemptedAt: rec.attemptedAt ?? new Date().toISOString(),
    attempts: (prior?.attempts ?? 0) + 1,
    oa: rec.oa ?? prior?.oa,
    proxy: rec.proxy ?? prior?.proxy,
    lastError: rec.lastError ?? prior?.lastError,
  };
  try {
    if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
    await fb.writeText(failurePath(lib, key), JSON.stringify(full, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Read a paper's fetch-failure record, or null if it never failed (or later succeeded). */
export async function readFetchFailure(key: string): Promise<FetchFailure | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    const p = failurePath(lib, key);
    if (!(await fb.exists(p))) return null;
    return JSON.parse(await fb.readText(p)) as FetchFailure;
  } catch {
    return null;
  }
}

/** Delete a paper's fetch-failure record (called on any successful fetch). */
export async function clearFetchFailure(key: string): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  try {
    const p = failurePath(lib, key);
    if (await fb.exists(p)) await fb.remove?.(p);
  } catch {
    /* best-effort */
  }
}

/** The set of citekeys (safeKey/NFC form) with a fetch-failure record — one readdir of
 *  items/ + a presence check (mirrors listPdfKeys; scales with attempted papers). Drives
 *  the bulk-run skip-list and the Library "failed N" filter. */
export async function listFailedKeys(): Promise<Set<string>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out = new Set<string>();
  if (!fb || !lib) return out;
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          if (await fb.exists(`${itemsBase(lib)}/${name}/${FETCH_FAILURE_JSON}`)) out.add(name.normalize("NFC"));
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/** LR-7: like listFailedKeys, but reads each failure record so the Library can show a durable
 *  per-row outcome pill (no DOI / no OA / failed) without expanding the row. Keyed NFC. Failures
 *  are the minority (only attempted-and-failed papers have a record), so the extra reads are few. */
// 2.3 Full-text search over items/*/fulltext.txt. The scan is a Node streaming job
// (flux-core/fulltextSearch.ts) run in the main process via the bundled CLI, so the
// renderer stays jank-free even over a 1k-paper library. Mirrors FulltextResult; a
// missing bridge (web/demo) or an error yields an empty result rather than throwing.
export interface FulltextSnippet {
  page: number;
  text: string;
}
export interface FulltextHit {
  key: string;
  count: number;
  snippets: FulltextSnippet[];
}
export interface FulltextResult {
  hits: FulltextHit[];
  scanned: number;
  missingText: string[];
  truncated: boolean;
  elapsedMs: number;
  error?: string;
}

const EMPTY_FT: FulltextResult = { hits: [], scanned: 0, missingText: [], truncated: false, elapsedMs: 0 };

export async function searchFulltext(
  query: string,
  opts?: { limit?: number; keys?: string[]; requestId?: string; ownerId?: string },
): Promise<FulltextResult> {
  // DEV/test seam: a headless harness (no Electron bridge) injects results here to
  // exercise the Library's full-text UI. Mirrors __fluxSeedBib / __fluxSeedFigures.
  if (import.meta.env?.DEV && typeof window !== "undefined") {
    const hook = (window as unknown as { __fluxFulltextHook?: (q: string, o?: unknown) => Partial<FulltextResult> }).__fluxFulltextHook;
    if (typeof hook === "function") return { ...EMPTY_FT, ...hook(query, opts) };
  }
  const fb = fileBridge() as { searchFulltext?: (q: string, o?: unknown) => Promise<Partial<FulltextResult>> } | null;
  if (!fb?.searchFulltext || !query.trim()) return EMPTY_FT;
  try {
    const r = await fb.searchFulltext(query, opts);
    return {
      hits: r.hits ?? [],
      scanned: r.scanned ?? 0,
      missingText: r.missingText ?? [],
      truncated: r.truncated ?? false,
      elapsedMs: r.elapsedMs ?? 0,
      error: r.error,
    };
  } catch (e) {
    return { ...EMPTY_FT, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listFailures(): Promise<Record<string, FetchFailure>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out: Record<string, FetchFailure> = {};
  if (!fb || !lib) return out;
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out;
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          const p = `${itemsBase(lib)}/${name}/${FETCH_FAILURE_JSON}`;
          if (await fb.exists(p)) out[name.normalize("NFC")] = JSON.parse(await fb.readText(p)) as FetchFailure;
        } catch {
          /* a corrupt/racing record just omits its pill */
        }
      }),
  );
  return out;
}
