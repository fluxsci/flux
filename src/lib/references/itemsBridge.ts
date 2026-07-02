// Renderer-side access to the FluxLib items/ store (the browser/Electron twin of
// flux-core/items.ts) — reads a stored PDF's bytes / provenance over window.fig.
// Reuses the pure path helpers (items.ts) + the resolved FluxLib path.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import {
  itemDir,
  itemsBase,
  pdfPath,
  fulltextPath,
  sourcePath,
  failurePath,
  safeKey,
  readerContextPath,
  PAPER_PDF,
  FETCH_FAILURE_JSON,
  type SourceInfo,
  type FetchFailure,
  type ReaderContext,
} from "./items";
import { isPdfBytes } from "./pdfFinder";

/** Write the live reader context (what the human is reading) so the agent's
 *  get_reading_context MCP tool can see it. Fills in the on-disk paths. Best-effort,
 *  debounced by the caller. */
export async function writeReaderContext(ctx: ReaderContext): Promise<void> {
  const fb = fileBridge();
  const lib = await resolveFluxLibPath();
  if (!fb || !lib) return;
  const full: ReaderContext = { ...ctx };
  if (ctx.citekey) {
    full.pdfPath = pdfPath(lib, ctx.citekey);
    full.fulltextPath = fulltextPath(lib, ctx.citekey);
  }
  try {
    if (fb.mkdir) await fb.mkdir(`${lib}/.fluxlib`);
    await fb.writeText(readerContextPath(lib), JSON.stringify(full, null, 2));
  } catch {
    /* best-effort */
  }
}
/** Clear the reader context when the reader closes / no paper is open. */
export async function clearReaderContext(): Promise<void> {
  await writeReaderContext({ citekey: "", updatedAt: new Date().toISOString() });
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
          // Store NFC-normalized: macOS/APFS returns readdir names as NFD while the .bib
          // stores citekeys as NFC — without this, accented keys (buzsáki, yüzgeç…) miss
          // the presence check and their PDFs flicker as "missing" between launches.
          if (await fb.exists(`${itemsBase(lib)}/${name}/${PAPER_PDF}`)) out.add(name.normalize("NFC"));
        } catch {
          /* ignore */
        }
      }),
  );
  return out;
}

/** True if `key`'s PDF dir-name is in a set produced by listPdfKeys(). NFC-normalized so
 *  the join is Unicode-normalization-invariant (see listPdfKeys). */
export const hasPdfIn = (pdfKeys: Set<string>, key: string): boolean =>
  pdfKeys.has(safeKey(key).normalize("NFC"));

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
