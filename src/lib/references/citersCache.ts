// Cache for "papers that cite this one" (forward citations).
//
// Unlike a reference list — immutable once published — a citer list grows forever and
// is a live OpenAlex query, so the reader would otherwise pay a network round trip
// every time you open the tab. This keeps the last fetch per (citekey, sort) in a
// DERIVED sidecar beside FluxLib's other caches: reopening is instant and works
// offline, and a ⟳ refresh re-queries when you want current numbers.
//
// It lives in its own file rather than in enrich.json deliberately: citer lists are
// heavy edge data (the enrich grid projection strips exactly this kind of field), and
// this cache is rebuildable — deleting it costs one refetch, never data.
import { fileBridge } from "../project/types";
import { resolveFluxLibPath } from "./fluxlibBridge";
import type { WorldBrief } from "./openalex";

export type CitersSort = "cited" | "recent";

export interface CitersEntry {
  fetchedAt: string; // ISO
  briefs: WorldBrief[];
}
interface CitersFile {
  version: 1;
  /** Keyed `<citekey>::<sort>`. */
  entries: Record<string, CitersEntry>;
}

const FILE = ".fluxlib/citers.json";
/** Keep the cache bounded — oldest fetches are dropped first. */
const MAX_ENTRIES = 120;

const cacheKey = (key: string, sort: CitersSort) => `${key}::${sort}`;
const emptyFile = (): CitersFile => ({ version: 1, entries: {} });

// Root and file generation are part of the cache identity. A completion from an
// old library may return to its owner but cannot replace the active mirror.
let mem: CitersFile | null = null;
let memPath = "", memToken = "", generation = 0;
let writes: Promise<void> = Promise.resolve();

async function filePath(): Promise<string | null> {
  const lib = await resolveFluxLibPath();
  return lib ? `${lib}/${FILE}` : null;
}

async function loadFile(p: string | null): Promise<CitersFile> {
  const fb = fileBridge();
  if (!fb || !p) return emptyFile();
  const token = fb.stat ? JSON.stringify(await fb.stat(p)) : "";
  if (mem && memPath === p && (!fb.stat || token === memToken)) return mem;
  const epoch = ++generation;
  let value = emptyFile();
  try {
    const parsed = (await fb.exists(p)) ? JSON.parse(await fb.readText(p)) as CitersFile : emptyFile();
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") value = parsed;
  } catch { /* Derived cache may rebuild; canonical data is handled elsewhere. */ }
  if (epoch === generation) { mem = value; memPath = p; memToken = token; }
  return value;
}

/** The cached citers for a paper+sort, or null when nothing is cached yet. */
export async function cachedCiters(key: string, sort: CitersSort): Promise<CitersEntry | null> {
  const f = await loadFile(await filePath());
  return f.entries[cacheKey(key, sort)] ?? null;
}

/** Store a fetched citer list. Best-effort: a failed write only costs a refetch. */
export async function cacheCiters(key: string, sort: CitersSort, briefs: WorldBrief[]): Promise<void> {
  const p = await filePath(); // capture the root before joining the write queue
  const operation = writes.then(async () => {
    const f = await loadFile(p);
    f.entries[cacheKey(key, sort)] = { fetchedAt: new Date().toISOString(), briefs };
    const keys = Object.keys(f.entries);
    if (keys.length > MAX_ENTRIES) keys.sort((a, b) => f.entries[a].fetchedAt.localeCompare(f.entries[b].fetchedAt))
      .slice(0, keys.length - MAX_ENTRIES).forEach(k => delete f.entries[k]);
    const fb = fileBridge();
    if (!fb || !p) return;
    await fb.mkdir(p.slice(0, p.lastIndexOf("/")));
    await fb.writeText(p, JSON.stringify(f, null, 2) + "\n");
    if (memPath === p) memToken = fb.stat ? JSON.stringify(await fb.stat(p)) : "";
  });
  writes = operation.catch(() => {}); // derived cache: retain queue after an I/O failure
  await writes;
}

/** Test seam + external-change hook: drop the in-memory mirror. */
export function invalidateCitersCache(): void {
  generation++; mem = null; memPath = ""; memToken = "";
}

/** DEV/test seam: prime the cache without a network round trip. */
export async function seedCitersCache(key: string, sort: CitersSort, briefs: WorldBrief[]): Promise<void> {
  const p = await filePath();
  const f = await loadFile(p);
  mem = f; memPath = p ?? "";
  f.entries[cacheKey(key, sort)] = { fetchedAt: new Date().toISOString(), briefs };
}
