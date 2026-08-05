// flux-core/items.ts — the FluxLib "items/" store (Node side: CLI/MCP/agents).
// Per-paper artifacts under <lib>/items/<citekey>/ — the filesystem IS the source of
// truth for these binaries (PDF, supplements, extracted text, annotations); a derived
// .fluxlib/items.json just caches presence for fast UI. The renderer twin
// (src/lib/references/itemsBridge.ts) mirrors this over window.fig.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveFluxLibPath, loadLibrary } from "./fluxlib";
import { atomicWrite } from "./fsx";
import {
  itemDir,
  pdfPath,
  linkPath,
  parsePdfLink,
  sourcePath,
  fulltextPath,
  annotationsPath,
  readerContextPath,
  oaMissesPath,
  supplementsDir,
  supplementFilePath,
  supplementManifestPath,
  safeSupplementName,
  parseSupplementManifest,
  type PdfLink,
  type SourceInfo,
  type ItemStatus,
  type ItemsIndex,
  type ReaderContext,
  type OaMissMap,
  type OaMissFile,
  type SupplementManifest,
} from "../src/lib/references/items";
import { isSupplementUrl, supplementDocSignal, supplementNameFromUrl, isAutomatedSource } from "../src/lib/references/supplement";

/** Node twin of itemsBridge's PdfWriteResult. `reason: "supplement"` is not an error — the
 *  bytes were supplementary material, they are filed under supplements/, and the caller
 *  should treat the article as still missing. */
export type PdfWriteResult = { ok: true; info: SourceInfo } | { ok: false; reason: "supplement"; signal: string; divertedTo?: string };

const libItemsIndexPath = (lib: string) => path.join(lib, ".fluxlib", "items.json");

/** Read the live FluxReader context (what the human is reading) — for the
 *  get_reading_context MCP tool. null if the reader hasn't written one. */
export async function readReaderContext(libPath?: string): Promise<ReaderContext | null> {
  try {
    return JSON.parse(await fs.readFile(readerContextPath(await lib(libPath)), "utf8")) as ReaderContext;
  } catch {
    return null;
  }
}

async function lib(libPath?: string): Promise<string> {
  return libPath ? path.resolve(libPath) : await resolveFluxLibPath();
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Load the OA-miss ledger (Node twin of itemsBridge.loadOaMisses — one aggregated file
 *  remembering papers with no open-access copy, so bulk runs skip re-checking them). */
export async function loadOaMisses(libPath?: string): Promise<OaMissMap> {
  try {
    const parsed = JSON.parse(await fs.readFile(oaMissesPath(await lib(libPath)), "utf8")) as OaMissFile;
    return parsed && typeof parsed.misses === "object" && parsed.misses ? parsed.misses : {};
  } catch {
    return {};
  }
}

/** Persist the OA-miss ledger (best-effort — a lost save just means a re-check later). */
export async function saveOaMisses(misses: OaMissMap, libPath?: string): Promise<void> {
  try {
    const p = oaMissesPath(await lib(libPath));
    await fs.mkdir(path.dirname(p), { recursive: true });
    const file: OaMissFile = { version: 1, misses };
    await atomicWrite(p, JSON.stringify(file, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

export async function ensureItemDir(key: string, libPath?: string): Promise<string> {
  const dir = itemDir(await lib(libPath), key);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function hasPdf(key: string, libPath?: string): Promise<boolean> {
  const L = await lib(libPath);
  return (await exists(pdfPath(L, key))) || (await exists(linkPath(L, key)));
}

/** The link-mode pointer for `key`, or null (absent/malformed). */
export async function readPdfLink(key: string, libPath?: string): Promise<PdfLink | null> {
  try {
    return parsePdfLink(await fs.readFile(linkPath(await lib(libPath), key), "utf8"));
  } catch {
    return null;
  }
}

/** Link-mode attach (Zotero sync `attach: "link"`): record a pointer to the external
 *  PDF instead of copying it. Provenance still lands in source.json; fulltext
 *  extraction is the CALLER's job (it has the bytes in hand). A stored paper.pdf is
 *  never displaced by a link — copy beats pointer. */
export async function writeLinkedPdf(key: string, absPath: string, libPath?: string): Promise<void> {
  const L = await lib(libPath);
  await ensureItemDir(key, L);
  const link: PdfLink = { path: absPath, linkedAt: new Date().toISOString() };
  await atomicWrite(linkPath(L, key), JSON.stringify(link, null, 2) + "\n");
  const info: SourceInfo = { key, source: "zotero-link", url: absPath, fetchedAt: link.linkedAt };
  await atomicWrite(sourcePath(L, key), JSON.stringify(info, null, 2) + "\n");
}

/**
 * Is this freshly-acquired PDF the article, or its supplementary material?
 * Node twin of itemsBridge.classifyAcquiredPdf — same rules module, so the CLI and the GUI
 * reach the same verdict. Returns a short reason when it is NOT the article, else null.
 */
export async function classifyAcquiredPdf(bytes: Uint8Array, finalUrl?: string): Promise<string | null> {
  if (finalUrl && isSupplementUrl(finalUrl)) return "supplement-url";
  try {
    const { extractPdfSignals } = await import("./fulltext");
    const s = await extractPdfSignals(new Uint8Array(bytes)); // fresh copy — pdf.js detaches
    return supplementDocSignal({ title: s.xmpTitle ?? s.infoTitle, page1Text: s.page1Text });
  } catch {
    return null; // extraction failed — don't block a write on a parse error
  }
}

/** Read the labelled supplement index for `key` (empty when absent — it's advisory). */
export async function readSupplementManifest(key: string, libPath?: string): Promise<SupplementManifest> {
  try {
    return parseSupplementManifest(await fs.readFile(supplementManifestPath(await lib(libPath), key), "utf8"));
  } catch {
    return { version: 1, items: [] };
  }
}

/**
 * File already-in-hand bytes into items/<key>/supplements/ and index them (Node twin of
 * itemsBridge.fileSupplementBytes). Returns the stored filename, or null.
 */
export async function fileSupplement(
  key: string,
  rawName: string,
  bytes: Uint8Array,
  meta: { label?: string; url?: string; source?: string } = {},
  libPath?: string,
): Promise<string | null> {
  const L = await lib(libPath);
  if (!bytes.length) return null;
  await fs.mkdir(supplementsDir(L, key), { recursive: true });
  let name = safeSupplementName(rawName || "supplement.pdf");
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = await readSupplementManifest(key, libPath);
  // Re-fetching the same supplement shouldn't accumulate -2, -3, … copies.
  const dup = manifest.items.find((r) => r.sha256 === sha256);
  if (dup && (await exists(supplementFilePath(L, key, dup.name)))) return dup.name;
  // The manifest is advisory and may be absent or predate hashing (files put here by the
  // repair, or by an older Flux), so the DISK is the authority: before suffixing a name,
  // check whether what's already there is byte-identical. Without this, every re-fetch of an
  // unindexed supplement lays down another -2, -3, … copy.
  for (let i = 2; await exists(supplementFilePath(L, key, name)); i++) {
    try {
      if (crypto.createHash("sha256").update(await fs.readFile(supplementFilePath(L, key, name))).digest("hex") === sha256) return name;
    } catch {
      /* unreadable — fall through and pick the next free name */
    }
    name = `${base}-${i}${ext}`;
  }
  await atomicWrite(supplementFilePath(L, key, name), bytes);
  try {
    const items = manifest.items.filter((r) => r.name !== name);
    items.push({ name, label: meta.label || undefined, url: meta.url, source: meta.source, bytes: bytes.byteLength, sha256, fetchedAt: new Date().toISOString() });
    items.sort((a, b) => a.name.localeCompare(b.name));
    await atomicWrite(supplementManifestPath(L, key), JSON.stringify({ version: 1, items }, null, 2) + "\n");
  } catch {
    /* advisory index — the file on disk is the truth */
  }
  return name;
}

/**
 * Write a fetched PDF + its provenance; computes sha256/bytes.
 *
 * Automated acquisitions are verified first: if the bytes turn out to be supplementary
 * material rather than the article, they are filed under supplements/ and NOT stored as
 * paper.pdf. See itemsBridge.writePdfItem for why this check lives at the write point.
 */
export async function writePdf(
  key: string,
  bytes: Uint8Array,
  source: Omit<SourceInfo, "key" | "sha256" | "bytes" | "fetchedAt"> & { fetchedAt?: string },
  libPath?: string,
): Promise<PdfWriteResult> {
  if (isAutomatedSource(source.source)) {
    const signal = await classifyAcquiredPdf(bytes, source.finalUrl ?? source.url);
    if (signal) {
      const divertedTo = await fileSupplement(key, supplementNameFromUrl(source.finalUrl ?? source.url) || "supplement.pdf", bytes, { url: source.finalUrl ?? source.url, source: source.source }, libPath);
      return { ok: false, reason: "supplement", signal, divertedTo: divertedTo ?? undefined };
    }
  }
  const L = await lib(libPath);
  await atomicWrite(pdfPath(L, key), bytes);
  const info: SourceInfo = {
    key,
    ...source,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    fetchedAt: source.fetchedAt ?? new Date().toISOString(),
  };
  await atomicWrite(sourcePath(L, key), JSON.stringify(info, null, 2) + "\n");
  return { ok: true, info };
}

export async function readPdf(key: string, libPath?: string): Promise<Buffer | null> {
  const L = await lib(libPath);
  try {
    return await fs.readFile(pdfPath(L, key));
  } catch {
    /* no stored copy — try the link-mode pointer */
  }
  const link = await readPdfLink(key, L);
  if (!link) return null;
  try {
    return await fs.readFile(link.path);
  } catch {
    return null; // external file moved/deleted — degrades to "PDF missing"
  }
}

export async function readSource(key: string, libPath?: string): Promise<SourceInfo | null> {
  try {
    return JSON.parse(await fs.readFile(sourcePath(await lib(libPath), key), "utf8")) as SourceInfo;
  } catch {
    return null;
  }
}

export async function writeFulltext(key: string, text: string, libPath?: string): Promise<void> {
  const L = await lib(libPath);
  await atomicWrite(fulltextPath(L, key), text);
}
export async function readFulltext(key: string, libPath?: string): Promise<string | null> {
  try {
    return await fs.readFile(fulltextPath(await lib(libPath), key), "utf8");
  } catch {
    return null;
  }
}

/** Count annotations without importing the annotation engine (cheap, for the index). */
async function annotationCount(L: string, key: string): Promise<number> {
  try {
    const j = JSON.parse(await fs.readFile(annotationsPath(L, key), "utf8"));
    return Array.isArray(j?.annotations) ? j.annotations.length : 0;
  } catch {
    return 0;
  }
}
async function countSupplements(L: string, key: string): Promise<number> {
  let n = 0;
  try {
    // Legacy flat supplement-N.<ext> files sitting directly in the item dir.
    const names = await fs.readdir(itemDir(L, key));
    n += names.filter((x) => /^supplement-/.test(x)).length;
  } catch {
    /* no item dir */
  }
  try {
    // The supplements/ folder (arbitrary filenames) — count regular, non-hidden files.
    const ents = await fs.readdir(supplementsDir(L, key), { withFileTypes: true });
    n += ents.filter((e) => e.isFile() && !e.name.startsWith(".")).length;
  } catch {
    /* no supplements/ folder */
  }
  return n;
}

/** Per-entry status by scanning the item dir. */
export async function itemStatus(key: string, libPath?: string): Promise<ItemStatus> {
  const L = await lib(libPath);
  const src = await readSource(key, L);
  return {
    key,
    hasPdf: (await exists(pdfPath(L, key))) || (await exists(linkPath(L, key))),
    supplements: await countSupplements(L, key),
    hasFulltext: await exists(fulltextPath(L, key)),
    annotations: await annotationCount(L, key),
    source: src?.source,
    fetchedAt: src?.fetchedAt,
  };
}

/** Rebuild the derived items index by scanning items/ for every library citekey. */
export async function rebuildItemsIndex(libPath?: string): Promise<ItemsIndex> {
  const L = await lib(libPath);
  const keys = (await loadLibrary(L)).map((e) => e.key);
  const idx: ItemsIndex = {};
  for (const k of keys) {
    const st = await itemStatus(k, L);
    if (st.hasPdf || st.annotations || st.supplements) idx[k] = st;
  }
  await atomicWrite(libItemsIndexPath(L), JSON.stringify(idx, null, 2) + "\n");
  return idx;
}

export async function loadItemsIndex(libPath?: string): Promise<ItemsIndex> {
  const L = await lib(libPath);
  try {
    return JSON.parse(await fs.readFile(libItemsIndexPath(L), "utf8")) as ItemsIndex;
  } catch {
    return await rebuildItemsIndex(L);
  }
}
