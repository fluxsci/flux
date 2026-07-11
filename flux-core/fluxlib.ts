// flux-core/fluxlib.ts — the FluxLib engine (Node, used by the CLI + MCP).
//
// FluxLib is the machine-global reference library (default ~/FluxLib): the single
// place references are *managed*. Each project keeps a materialized cited-subset
// references/library.bib (so a project still zips/clones/renders standalone — the
// self-containment tenet). See notes/Flux_Project_Format.md §6 and the FluxLib plan.
//
// Layout (Tier 0 canonical text + Tier 2 derived index; Tier 1 items/ is future):
//   <lib>/library.bib            canonical BibLaTeX — the source of truth
//   <lib>/fluxlib.json           manifest (own schemaVersion)
//   <lib>/.fluxlib/index.json    derived LibraryIndex (rebuildable; git-ignored)
//
// The query engine is deliberately a *derived* layer behind loadIndex/searchReferences,
// so SQLite/DuckDB can replace the JSON index later without touching the .bib truth.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RefEntry, AddResult, EnrichEntry } from "../src/lib/references/types";
import type { ProjectManifest } from "../src/lib/project/types";
export type { AddResult };
import { runQuery } from "../src/lib/references/query";
import { enrichCoverage, projectEnrichForGrid } from "../src/lib/references/enrich";
import { planAdds, appendedBib } from "../src/lib/references/addPlan";
import { normalizeOrganize, setTags, setStatus, setCollections, mergeOrganize, type OrganizeData, type ReadingStatus } from "../src/lib/references/organize";
import { atomicWrite, quarantineCorrupt } from "./fsx";
import { withLockAt, withLock, fluxlibLockDir, getLockClient } from "./locks";
import { splitBibEntries, lightEntry, bibtexKey } from "../src/lib/references/bibtex";
import * as fluxPaths from "../electron/fluxPaths.cjs";

const SCHEMA_VERSION = "0.1.0";

// --------------------------------------------------------------------------
// paths + preferences (the first file-based global config the CLI/agents read)
// --------------------------------------------------------------------------

/** The machine config dir — LOWERCASE "flux" on every platform. Delegates to
 *  electron/fluxPaths.cjs, the ONE resolver shared with the Electron main
 *  process (which pins app.getPath("userData") to the same dir), so the
 *  CLI/MCP and the app always read the SAME preferences.json. */
export function userDataDir(platform?: NodeJS.Platform): string {
  return fluxPaths.userDataDir(platform);
}

const prefsPath = () => path.join(userDataDir(), "preferences.json");

interface Preferences {
  schemaVersion: string;
  fluxLibPath?: string;
  [k: string]: unknown;
}

export async function getPreferences(): Promise<Preferences> {
  try {
    return JSON.parse(await fs.readFile(prefsPath(), "utf8")) as Preferences;
  } catch {
    return { schemaVersion: SCHEMA_VERSION };
  }
}

export async function setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const cur = await getPreferences();
  const next = { ...cur, ...patch, schemaVersion: cur.schemaVersion || SCHEMA_VERSION };
  await atomicWrite(prefsPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** The pre-FluxConfig default — kept only as the resolver's last legacy
 *  fallback; FluxLib's real home is derived from FluxConfig. */
export const defaultFluxLibPath = (): string => path.join(os.homedir(), "FluxLib");

/** The FluxLib path — DERIVED: <FluxConfig>/FluxLib, with legacy fallbacks
 *  that only apply pre-migration (see fluxPaths.resolveFluxLibPathSync). */
export async function resolveFluxLibPath(): Promise<string> {
  return fluxPaths.resolveFluxLibPathSync(await getPreferences());
}

/** The user-facing FluxConfig folder (preferences pointer → ~/FluxConfig). */
export async function resolveFluxConfigPath(): Promise<string> {
  return fluxPaths.resolveFluxConfigPathSync(await getPreferences());
}

/** <FluxConfig>/Guidelines — the machine-wide conventions agents always read. */
export async function guidelinesPath(): Promise<string> {
  return fluxPaths.guidelinesPathSync(await getPreferences());
}

/** One-time machine init/migration (FluxConfig + lowercase config dir +
 *  FluxLib move + Guidelines seed). Idempotent, locked, fast after first run. */
export const ensureFluxConfig = fluxPaths.ensureFluxConfig;

const libBib = (lib: string) => path.join(lib, "library.bib");
const libManifest = (lib: string) => path.join(lib, "fluxlib.json");
const libIndexPath = (lib: string) => path.join(lib, ".fluxlib", "index.json");
const libEnrichPath = (lib: string) => path.join(lib, ".fluxlib", "enrich.json");

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// trivial project helpers (kept local so this module never imports index.ts → no cycle)
async function readManifest(root: string): Promise<ProjectManifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8")) as ProjectManifest;
  } catch {
    return null;
  }
}
function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  return abs;
}
const projectBibPath = (root: string, m?: ProjectManifest | null) =>
  path.join(root, m?.references?.library ?? "references/library.bib");

// --------------------------------------------------------------------------
// bootstrap
// --------------------------------------------------------------------------

/**
 * Ensure the FluxLib exists: create the dir, an empty `library.bib`, and
 * `fluxlib.json`. On first creation, migrate a legacy
 * `<userData>/references/library.bib` seed in. Idempotent; returns the FluxLib
 * path. (No path is persisted — FluxLib is derived from FluxConfig; the
 * pointer preference is fluxConfigPath, owned by ensureFluxConfig.)
 */
export async function ensureFluxLib(libPath?: string): Promise<string> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await fs.mkdir(path.join(lib, ".fluxlib"), { recursive: true });
  // The watched drop-inbox must exist for anyone to drop PDFs into it.
  await fs.mkdir(path.join(lib, "pdfs_to_assign"), { recursive: true });
  if (!(await exists(libBib(lib)))) {
    let seed = "";
    const legacy = path.join(userDataDir(), "references", "library.bib");
    if (await exists(legacy)) {
      try {
        const t = (await fs.readFile(legacy, "utf8")).trimEnd();
        if (t) seed = t + "\n";
      } catch {
        /* fall through to header */
      }
    }
    await atomicWrite(
      libBib(lib),
      seed || "% FluxLib — your machine-global reference library (BibLaTeX). Canonical source of truth.\n",
    );
  }
  if (!(await exists(libManifest(lib)))) {
    await atomicWrite(
      libManifest(lib),
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          created: new Date().toISOString(),
          defaults: { csl: null },
          counts: { entries: 0, withPdf: 0 },
        },
        null,
        2,
      ) + "\n",
    );
  }
  return lib;
}

// --------------------------------------------------------------------------
// read + derived index (LibraryIndex — JSON impl behind a stable boundary)
// --------------------------------------------------------------------------

/** Parse FluxLib `library.bib` into entries (raw preserved). */
export async function loadLibrary(libPath?: string): Promise<RefEntry[]> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  if (!(await exists(libBib(lib)))) return [];
  const text = await fs.readFile(libBib(lib), "utf8");
  return splitBibEntries(text)
    .map(lightEntry)
    .filter((e) => e.key);
}

export interface LibraryIndex {
  schemaVersion: string;
  builtAt: string;
  entries: Record<string, RefEntry>; // by citekey; `raw` omitted to stay lean
}

/** Build + write `.fluxlib/index.json` from `library.bib` (the canonical source). */
export async function buildIndex(libPath?: string): Promise<LibraryIndex> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  const entries = await loadLibrary(lib);
  const map: Record<string, RefEntry> = {};
  for (const e of entries) {
    const slim = { ...e };
    delete slim.raw;
    map[e.key] = slim;
  }
  const idx: LibraryIndex = {
    schemaVersion: SCHEMA_VERSION,
    builtAt: new Date().toISOString(),
    entries: map,
  };
  await atomicWrite(libIndexPath(lib), JSON.stringify(idx, null, 2) + "\n");
  return idx;
}

/** Load the index, rebuilding when missing or older than `library.bib`
 *  (derived → the .bib always wins). */
export async function loadIndex(libPath?: string): Promise<LibraryIndex> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  try {
    const [bibStat, idxStat] = await Promise.all([
      fs.stat(libBib(lib)).catch(() => null),
      fs.stat(libIndexPath(lib)).catch(() => null),
    ]);
    if (!idxStat) return await buildIndex(lib);
    if (bibStat && bibStat.mtimeMs > idxStat.mtimeMs) return await buildIndex(lib);
    return JSON.parse(await fs.readFile(libIndexPath(lib), "utf8")) as LibraryIndex;
  } catch {
    return await buildIndex(lib);
  }
}

/** search_references / `flux search`: structured query over the FluxLib index. */
export async function searchReferences(query: string, libPath?: string): Promise<RefEntry[]> {
  const idx = await loadIndex(libPath);
  let entries: RefEntry[] = Object.values(idx.entries);
  // 3.3: only pay the organize.json read when the query actually filters on it.
  if (/(?:^|\s)(?:tag|tags|status|read|collection|collections|coll):/i.test(query)) {
    entries = mergeOrganize(entries, await loadOrganize(libPath));
  }
  return runQuery(entries, query);
}

// --------------------------------------------------------------------------
// enrichment sidecar (Tier 1+2 — derived, rebuildable; keyed by citekey)
// --------------------------------------------------------------------------

/** Load the enrichment sidecar (`<lib>/.fluxlib/enrich.json`); `{}` if absent.
 *  W2: an unparseable file is quarantined as `.corrupt-<ts>` and reported —
 *  never silently treated as empty (which used to wipe the cache on next write). */
// mtime-keyed parse cache (B1 parity with the renderer's enrichStore): the resident
// MCP server serves many lookups per session — parse the ~12MB sidecar once per
// actual file change, not per verb. One-shot CLI runs are unaffected.
const enrichCache = new Map<string, { key: string; map: Record<string, EnrichEntry> }>();

export async function loadEnrich(libPath?: string): Promise<Record<string, EnrichEntry>> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  const p = libEnrichPath(lib);
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    const s = await fs.stat(p);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    enrichCache.delete(lib);
    return {}; // genuinely absent
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = enrichCache.get(lib);
  if (hit && hit.key === key) return hit.map;
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    enrichCache.delete(lib);
    return {}; // vanished between stat and read
  }
  try {
    const map = JSON.parse(text) as Record<string, EnrichEntry>;
    enrichCache.set(lib, { key, map });
    return map;
  } catch {
    const q = await quarantineCorrupt(libEnrichPath(lib));
    console.error(
      `[flux] enrich.json is corrupt${q ? ` — quarantined to ${q}` : ""}; starting a fresh cache (re-run hydrate)`,
    );
    return {};
  }
}

const libEnrichGridPath = (lib: string) => path.join(lib, ".fluxlib", "enrich-grid.json");

/** Write the enrichment sidecar. Derived → safe to delete/rebuild; never the `.bib`.
 *  WS-8.3: also emits the GRID projection (display fields only, compact JSON)
 *  AFTER the full file, so grid.mtime ≥ full.mtime is the renderer's freshness
 *  rule — a stale/missing grid falls back to parsing the full file. */
export async function writeEnrich(
  map: Record<string, EnrichEntry>,
  libPath?: string,
): Promise<void> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await atomicWrite(libEnrichPath(lib), JSON.stringify(map, null, 2) + "\n");
  await atomicWrite(libEnrichGridPath(lib), JSON.stringify(projectEnrichForGrid(map)) + "\n");
}

/** W3: merge this run's fetched entries into enrich.json under the "enrich"
 *  lock, re-loading fresh state first — so a minutes-long hydrate (which holds
 *  its snapshot across the network loop) can't wipe entries another process
 *  wrote meanwhile. Only the DELTA overwrites; everything else is preserved. */
export async function mergeEnrichDelta(
  delta: Record<string, EnrichEntry>,
  libPath?: string,
): Promise<void> {
  if (!Object.keys(delta).length) return;
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await withLockAt(
    fluxlibLockDir(lib),
    "enrich",
    getLockClient(),
    async () => {
      const fresh = await loadEnrich(lib);
      await atomicWrite(libEnrichPath(lib), JSON.stringify({ ...fresh, ...delta }, null, 2) + "\n");
    },
    { retries: 8 },
  );
}

/** A compact info rollup for `flux lib` (size + hydration coverage). */
export async function fluxLibInfo(
  libPath?: string,
): Promise<{ path: string; entries: number; hydrated: number; withAbstract: number }> {
  const lib = await ensureFluxLib(libPath);
  const entries = (await loadLibrary(lib)).length;
  const cov = enrichCoverage(entries, await loadEnrich(lib));
  return { path: lib, entries, hydrated: cov.hydrated, withAbstract: cov.withAbstract };
}

// --------------------------------------------------------------------------
// 3.3 Library organization — tags / reading-status / collections, stored in a
// citekey-keyed sidecar (.fluxlib/organize.json). Mutations are locked RMWs under
// the "library" lock (concurrent GUI/CLI/MCP edits merge, never clobber).
// --------------------------------------------------------------------------
const libOrganizePath = (lib: string) => path.join(lib, ".fluxlib", "organize.json");

export async function loadOrganize(libPath?: string): Promise<OrganizeData> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  try {
    return normalizeOrganize(JSON.parse(await fs.readFile(libOrganizePath(lib), "utf8")));
  } catch {
    return { version: 1, items: {} };
  }
}

async function mutateOrganize(fn: (d: OrganizeData) => OrganizeData, libPath?: string): Promise<OrganizeData> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await fs.mkdir(path.join(lib, ".fluxlib"), { recursive: true });
  return withLockAt(
    fluxlibLockDir(lib),
    "library",
    getLockClient(),
    async () => {
      const next = fn(await loadOrganize(lib));
      await atomicWrite(libOrganizePath(lib), JSON.stringify(next, null, 2) + "\n");
      return next;
    },
    { retries: 8 },
  );
}

export const organizeSetTags = (key: string, tags: string[], libPath?: string): Promise<OrganizeData> =>
  mutateOrganize((d) => setTags(d, key, tags), libPath);
export const organizeSetStatus = (key: string, status: ReadingStatus | undefined, libPath?: string): Promise<OrganizeData> =>
  mutateOrganize((d) => setStatus(d, key, status), libPath);
export const organizeSetCollections = (key: string, collections: string[], libPath?: string): Promise<OrganizeData> =>
  mutateOrganize((d) => setCollections(d, key, collections), libPath);

// --------------------------------------------------------------------------
// API keys / secrets — machine-global (shared across every project) in ~/FluxLib
// --------------------------------------------------------------------------

const libKeysPath = (lib: string) => path.join(lib, "keys.json");

export interface FluxKeys {
  mailto?: string; // polite-pool email for OpenAlex/CrossRef
  openAlexKey?: string; // free OpenAlex key → 10× daily budget
  s2Key?: string; // free Semantic Scholar key
  [k: string]: unknown;
}

/** Read `~/FluxLib/keys.json` (`{}` if absent). Plaintext, machine-global. */
export async function loadKeys(libPath?: string): Promise<FluxKeys> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  try {
    return JSON.parse(await fs.readFile(libKeysPath(lib), "utf8")) as FluxKeys;
  } catch {
    return {};
  }
}

/** Merge-write keys into `~/FluxLib/keys.json` (creates FluxLib if needed). */
export async function saveKeys(patch: FluxKeys, libPath?: string): Promise<FluxKeys> {
  const lib = await ensureFluxLib(libPath);
  return withLockAt(
    fluxlibLockDir(lib),
    "keys",
    getLockClient(),
    async () => {
      const next = { ...(await loadKeys(lib)), ...patch };
      await atomicWrite(libKeysPath(lib), JSON.stringify(next, null, 2) + "\n");
      return next;
    },
    { retries: 8 },
  );
}

const SECRET_ENV: Record<string, string> = {
  mailto: "FLUX_MAILTO",
  openAlexKey: "OPENALEX_API_KEY",
  s2Key: "S2_API_KEY",
};

/** Resolve a credential: env var → `~/FluxLib/keys.json` → undefined.
 *  Lets agents/CI override via env while the GUI user stores keys in the file. */
export async function getSecret(
  name: "mailto" | "openAlexKey" | "s2Key",
  libPath?: string,
): Promise<string | undefined> {
  const env = process.env[SECRET_ENV[name]];
  if (env && env.trim()) return env.trim();
  const v = (await loadKeys(libPath))[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// --------------------------------------------------------------------------
// add (with DOI dedup) + materialize into a project subset
// --------------------------------------------------------------------------

/**
 * Add BibTeX to FluxLib, deduping by DOI. `source:"doi"` re-keys to the
 * deterministic scheme (DOI-fetched keys are throwaway); `source:"bibtex"`
 * preserves the provided citekey (suffixing only on collision) so a Zotero/
 * EndNote export keeps the keys a manuscript may already cite. Rebuilds the index.
 */
export async function addToFluxLib(
  bibtex: string,
  opts: { source?: "doi" | "bibtex"; libPath?: string } = {},
): Promise<AddResult> {
  const source = opts.source ?? "bibtex";
  const lib = await ensureFluxLib(opts.libPath);
  // W3: the whole read→dedupe→append→write is one locked unit on the FluxLib —
  // a concurrent app "Add by DOI" + CLI lib-add can no longer lose an entry.
  // Mutations are ms-scale, so contenders retry briefly instead of erroring.
  return withLockAt(
    fluxlibLockDir(lib),
    "library",
    getLockClient(),
    () => addToFluxLibLocked(lib, bibtex, source),
    { retries: 8 },
  );
}

async function addToFluxLibLocked(
  lib: string,
  bibtex: string,
  source: "doi" | "bibtex",
): Promise<AddResult> {
  const curText = await fs.readFile(libBib(lib), "utf8");
  // The dedupe/rekey decision (DOI, then title+year+author signature, incl. intra-batch)
  // lives in the shared pure planner so preview == outcome; this twin only does the write.
  const plan = planAdds(curText, bibtex, source);
  if (plan.appendText) {
    await atomicWrite(libBib(lib), appendedBib(curText, plan));
    await buildIndex(lib);
  }
  return { added: plan.added, deduped: plan.deduped, keys: plan.keys };
}

/**
 * Append FluxLib entries for `citekeys` into the project's references/library.bib.
 * Idempotent (skips keys already in the project bib; skips keys absent from FluxLib).
 * Non-destructive — never removes entries. Returns the keys actually added.
 */
export async function materializeIntoProject(
  root: string,
  citekeys: string[],
  opts: { libPath?: string; manifest?: ProjectManifest | null } = {},
): Promise<{ added: string[] }> {
  if (!citekeys.length) return { added: [] };
  // W3: the project bib append is an RMW — locked at project scope ("references")
  // so it can't interleave with the app's own cite-materialization.
  return withLock(root, "references", getLockClient(), () =>
    materializeIntoProjectLocked(root, citekeys, opts),
  );
}

async function materializeIntoProjectLocked(
  root: string,
  citekeys: string[],
  opts: { libPath?: string; manifest?: ProjectManifest | null } = {},
): Promise<{ added: string[] }> {
  const lib = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const libText = (await exists(libBib(lib))) ? await fs.readFile(libBib(lib), "utf8") : "";
  const libRawByKey = new Map<string, string>();
  for (const r of splitBibEntries(libText)) {
    const k = bibtexKey(r);
    if (k) libRawByKey.set(k, r);
  }

  const manifest = opts.manifest ?? (await readManifest(root));
  const pbib = projectBibPath(root, manifest);
  const projText = (await exists(pbib)) ? await fs.readFile(pbib, "utf8") : "";
  const projKeys = new Set(
    splitBibEntries(projText)
      .map(bibtexKey)
      .filter(Boolean) as string[],
  );

  const toAdd: string[] = [];
  const addedKeys: string[] = [];
  for (const k of citekeys) {
    if (projKeys.has(k) || !libRawByKey.has(k)) continue;
    toAdd.push(libRawByKey.get(k) as string);
    addedKeys.push(k);
    projKeys.add(k);
  }
  if (toAdd.length) {
    const sep = projText && !projText.endsWith("\n") ? "\n" : "";
    await atomicWrite(pbib, projText + sep + toAdd.join("\n\n") + "\n");
  }
  return { added: addedKeys };
}

// --------------------------------------------------------------------------
// reconcile a project against FluxLib (on open / on demand)
// --------------------------------------------------------------------------

const CITE_RE = /@([A-Za-z][\w:.-]*)/g;
const isCrossref = (k: string) => /^(?:fig|tbl|sec|eq)-/.test(k);

function citedKeysIn(text: string): string[] {
  const out = new Set<string>();
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(text))) if (!isCrossref(m[1])) out.add(m[1]);
  return [...out];
}

/**
 * Ensure every key the manuscript cites is present in the project bib —
 * promoting any project-local-only cited entries UP into FluxLib first (so a
 * pre-FluxLib project's references become reusable, and nothing is lost).
 * Non-destructive: never prunes. Returns orphans (cited, found nowhere).
 */
export async function reconcileProject(
  root: string,
  opts: { libPath?: string } = {},
): Promise<{ materialized: string[]; promoted: string[]; orphans: string[] }> {
  const lib = await ensureFluxLib(opts.libPath);
  const manifest = await readManifest(root);
  const docs = manifest
    ? ([manifest.manuscript?.path, ...(manifest.supplementary ?? []).map((s) => s.path)].filter(
        Boolean,
      ) as string[])
    : ["manuscript/main.qmd"];

  const cited = new Set<string>();
  for (const rel of docs) {
    try {
      citedKeysIn(await fs.readFile(safeJoin(root, rel), "utf8")).forEach((k) => cited.add(k));
    } catch {
      /* missing/unreadable doc */
    }
  }
  if (!cited.size) return { materialized: [], promoted: [], orphans: [] };

  const libKeys = new Set((await loadLibrary(lib)).map((e) => e.key));
  const pbib = projectBibPath(root, manifest);
  const projText = (await exists(pbib)) ? await fs.readFile(pbib, "utf8") : "";
  const projRawByKey = new Map<string, string>();
  for (const r of splitBibEntries(projText)) {
    const k = bibtexKey(r);
    if (k) projRawByKey.set(k, r);
  }

  const promoted: string[] = [];
  for (const k of cited) {
    if (!libKeys.has(k) && projRawByKey.has(k)) {
      await addToFluxLib(projRawByKey.get(k) as string, { source: "bibtex", libPath: lib });
      libKeys.add(k);
      promoted.push(k);
    }
  }
  const { added } = await materializeIntoProject(root, [...cited], { libPath: lib, manifest });
  const orphans = [...cited].filter((k) => !libKeys.has(k) && !projRawByKey.has(k));
  return { materialized: added, promoted, orphans };
}
