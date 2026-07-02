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
import { makeCitekey, dupeSignature } from "../src/lib/references/citekey";
import { runQuery } from "../src/lib/references/query";
import { enrichCoverage } from "../src/lib/references/enrich";
import { atomicWrite, quarantineCorrupt } from "./fsx";
import { withLockAt, withLock, fluxlibLockDir, getLockClient } from "./locks";
import {
  splitBibEntries,
  lightEntry,
  bibtexKey,
  rekeyBibtex,
} from "../src/lib/references/bibtex";

const SCHEMA_VERSION = "0.1.0";

// --------------------------------------------------------------------------
// paths + preferences (the first file-based global config the CLI/agents read)
// --------------------------------------------------------------------------

/** Electron's `app.getPath("userData")` with productName "Flux", reproduced for
 *  the CLI/MCP (which have no Electron) so both read the SAME preferences.json. */
export function userDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Flux");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Flux");
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Flux");
  }
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

export const defaultFluxLibPath = (): string => path.join(os.homedir(), "FluxLib");

/** The configured FluxLib path (preferences → default ~/FluxLib). */
export async function resolveFluxLibPath(): Promise<string> {
  const p = (await getPreferences()).fluxLibPath;
  return p && String(p).trim() ? path.resolve(String(p)) : defaultFluxLibPath();
}

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
 * `<userData>/references/library.bib` seed in. Persists the resolved path to
 * preferences so the GUI and CLI agree. Idempotent; returns the FluxLib path.
 */
export async function ensureFluxLib(libPath?: string): Promise<string> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await fs.mkdir(path.join(lib, ".fluxlib"), { recursive: true });
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
  const prefs = await getPreferences();
  if (!prefs.fluxLibPath) await setPreferences({ fluxLibPath: lib });
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
  return runQuery(Object.values(idx.entries), query);
}

// --------------------------------------------------------------------------
// enrichment sidecar (Tier 1+2 — derived, rebuildable; keyed by citekey)
// --------------------------------------------------------------------------

/** Load the enrichment sidecar (`<lib>/.fluxlib/enrich.json`); `{}` if absent.
 *  W2: an unparseable file is quarantined as `.corrupt-<ts>` and reported —
 *  never silently treated as empty (which used to wipe the cache on next write). */
export async function loadEnrich(libPath?: string): Promise<Record<string, EnrichEntry>> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  let text: string;
  try {
    text = await fs.readFile(libEnrichPath(lib), "utf8");
  } catch {
    return {}; // genuinely absent
  }
  try {
    return JSON.parse(text) as Record<string, EnrichEntry>;
  } catch {
    const q = await quarantineCorrupt(libEnrichPath(lib));
    console.error(
      `[flux] enrich.json is corrupt${q ? ` — quarantined to ${q}` : ""}; starting a fresh cache (re-run hydrate)`,
    );
    return {};
  }
}

/** Write the enrichment sidecar. Derived → safe to delete/rebuild; never the `.bib`. */
export async function writeEnrich(
  map: Record<string, EnrichEntry>,
  libPath?: string,
): Promise<void> {
  const lib = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await atomicWrite(libEnrichPath(lib), JSON.stringify(map, null, 2) + "\n");
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

  const taken = new Set<string>();
  const doiToKey = new Map<string, string>();
  const sigToKey = new Map<string, string>(); // LR-9: title+year+author dedup when DOI absent
  for (const r of splitBibEntries(curText)) {
    const k = bibtexKey(r);
    if (k) taken.add(k);
    const e = lightEntry(r);
    if (e.doi) doiToKey.set(e.doi.toLowerCase(), k || e.key);
    const sig = dupeSignature(e);
    if (sig && !sigToKey.has(sig)) sigToKey.set(sig, k || e.key);
  }

  const added: RefEntry[] = [];
  const deduped: RefEntry[] = [];
  const keys: string[] = [];
  const appendBuf: string[] = [];

  for (const raw of splitBibEntries(bibtex)) {
    const e = lightEntry(raw);
    const doi = e.doi?.toLowerCase();
    if (doi && doiToKey.has(doi)) {
      const k = doiToKey.get(doi) as string;
      deduped.push({ ...e, key: k });
      keys.push(k);
      continue;
    }
    // LR-9: no DOI match — fall back to a normalized title+year+author signature so a paper
    // added without a DOI and re-added with one (or vice-versa) collapses to one citekey.
    const sig = dupeSignature(e);
    if (sig && sigToKey.has(sig)) {
      const k = sigToKey.get(sig) as string;
      if (doi) doiToKey.set(doi, k);
      deduped.push({ ...e, key: k });
      keys.push(k);
      continue;
    }
    const orig = bibtexKey(raw);
    const key = source === "bibtex" && orig && !taken.has(orig) ? orig : makeCitekey(e, taken);
    const outRaw = rekeyBibtex(raw, key);
    taken.add(key);
    if (doi) doiToKey.set(doi, key);
    if (sig && !sigToKey.has(sig)) sigToKey.set(sig, key);
    const entry: RefEntry = { ...e, key, raw: outRaw };
    added.push(entry);
    keys.push(key);
    appendBuf.push(outRaw);
  }

  if (appendBuf.length) {
    const sep = curText && !curText.endsWith("\n") ? "\n" : "";
    await atomicWrite(libBib(lib), curText + sep + appendBuf.join("\n\n") + "\n");
    await buildIndex(lib);
  }
  return { added, deduped, keys };
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
