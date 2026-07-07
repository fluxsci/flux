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
  sourcePath,
  fulltextPath,
  annotationsPath,
  readerContextPath,
  oaMissesPath,
  supplementsDir,
  type SourceInfo,
  type ItemStatus,
  type ItemsIndex,
  type ReaderContext,
  type OaMissMap,
  type OaMissFile,
} from "../src/lib/references/items";

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
  return exists(pdfPath(await lib(libPath), key));
}

/** Write a fetched PDF + its provenance; computes sha256/bytes. Returns the SourceInfo. */
export async function writePdf(
  key: string,
  bytes: Uint8Array,
  source: Omit<SourceInfo, "key" | "sha256" | "bytes" | "fetchedAt"> & { fetchedAt?: string },
  libPath?: string,
): Promise<SourceInfo> {
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
  return info;
}

export async function readPdf(key: string, libPath?: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(pdfPath(await lib(libPath), key));
  } catch {
    return null;
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
    hasPdf: await exists(pdfPath(L, key)),
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
