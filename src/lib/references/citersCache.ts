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

// In-memory mirror so repeated tab switches don't re-read the file.
let mem: CitersFile | null = null;

async function filePath(): Promise<string | null> {
  const lib = await resolveFluxLibPath();
  return lib ? `${lib}/${FILE}` : null;
}

async function loadFile(): Promise<CitersFile> {
  if (mem) return mem;
  const fb = fileBridge();
  const p = await filePath();
  if (!fb || !p) return (mem = emptyFile());
  try {
    const parsed = (await fb.exists(p)) ? (JSON.parse(await fb.readText(p)) as CitersFile) : emptyFile();
    mem = parsed?.version === 1 && parsed.entries ? parsed : emptyFile();
  } catch {
    mem = emptyFile(); // unparseable → treat as cold, never as an error
  }
  return mem;
}

/** The cached citers for a paper+sort, or null when nothing is cached yet. */
export async function cachedCiters(key: string, sort: CitersSort): Promise<CitersEntry | null> {
  const f = await loadFile();
  return f.entries[cacheKey(key, sort)] ?? null;
}

/** Store a fetched citer list. Best-effort: a failed write only costs a refetch. */
export async function cacheCiters(key: string, sort: CitersSort, briefs: WorldBrief[]): Promise<void> {
  const f = await loadFile();
  f.entries[cacheKey(key, sort)] = { fetchedAt: new Date().toISOString(), briefs };
  const keys = Object.keys(f.entries);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (f.entries[a].fetchedAt < f.entries[b].fetchedAt ? -1 : 1))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete f.entries[k]);
  }
  const fb = fileBridge();
  const p = await filePath();
  if (!fb || !p) return;
  try {
    await fb.mkdir(p.slice(0, p.lastIndexOf("/")));
    await fb.writeText(p, JSON.stringify(f, null, 2) + "\n");
  } catch {
    /* derived cache — a write failure is not an error worth surfacing */
  }
}

/** Test seam + external-change hook: drop the in-memory mirror. */
export function invalidateCitersCache(): void {
  mem = null;
}

/** DEV/test seam: prime the cache without a network round trip. */
export function seedCitersCache(key: string, sort: CitersSort, briefs: WorldBrief[]): void {
  const f = mem ?? (mem = emptyFile());
  f.entries[cacheKey(key, sort)] = { fetchedAt: new Date().toISOString(), briefs };
}
