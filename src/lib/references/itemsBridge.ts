// Renderer-side access to the FluxLib items/ store (the browser/Electron twin of
// flux-core/items.ts) — reads a stored PDF's bytes / provenance over window.fig.
// Reuses the pure path helpers (items.ts) + the resolved FluxLib path.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { itemDir, itemsBase, pdfPath, sourcePath, safeKey, PAPER_PDF, type SourceInfo } from "./items";
import { isPdfBytes } from "./pdfFinder";

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
  return writePdfItem(key, bytes, { source: "ingest", url: filePath, finalUrl: filePath });
}

/** The set of citekeys (safeKey form) that have a paper.pdf on disk — one readdir of
 *  items/ + a presence check per item dir (scales with fetched papers, not library
 *  size). Used by the Library to show a "has PDF" pill and gate the "Read" action. */
export async function listPdfKeys(): Promise<Set<string>> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  const out = new Set<string>();
  if (!fb || !lib) return out;
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await fb.readdir?.(itemsBase(lib))) ?? [];
  } catch {
    return out; // no items/ yet
  }
  await Promise.all(
    entries
      .filter((e) => e.dir)
      .map(async ({ name }) => {
        try {
          if (await fb.exists(`${itemsBase(lib)}/${name}/${PAPER_PDF}`)) out.add(name);
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/** True if `key`'s PDF dir-name is in a set produced by listPdfKeys(). */
export const hasPdfIn = (pdfKeys: Set<string>, key: string): boolean => pdfKeys.has(safeKey(key));

/** File a fetched PDF into items/<key>/ + write source.json provenance (renderer twin
 *  of flux-core writePdf). Computes a SHA-256 via WebCrypto for parity. */
export async function writePdfItem(
  key: string,
  bytes: Uint8Array,
  info: { source: string; url?: string; finalUrl?: string; isOa?: boolean; license?: string },
): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  if (fb.mkdir) await fb.mkdir(itemDir(lib, key));
  await fb.writeFile(pdfPath(lib, key), bytes);
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
  await fb.writeText(sourcePath(lib, key), JSON.stringify(source, null, 2) + "\n");
  return true;
}

/** Read a stored PDF's bytes (ArrayBuffer) for the reader, or null if absent. */
export async function readerPdfBytes(key: string): Promise<ArrayBuffer | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  const p = pdfPath(lib, key);
  try {
    return (await fb.exists(p)) ? await fb.readFile(p) : null;
  } catch {
    return null;
  }
}

export async function readerHasPdf(key: string): Promise<boolean> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return false;
  try {
    return await fb.exists(pdfPath(lib, key));
  } catch {
    return false;
  }
}

export async function readerSource(key: string): Promise<SourceInfo | null> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return null;
  try {
    return JSON.parse(await fb.readText(sourcePath(lib, key))) as SourceInfo;
  } catch {
    return null;
  }
}
