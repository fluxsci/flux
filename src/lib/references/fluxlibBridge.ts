// Renderer-side FluxLib adapter — the browser/Electron twin of flux-core/fluxlib.ts.
// The renderer can't use node:fs, so this mirrors that engine's orchestration over
// the FileBridge (window.fig), reusing the SAME pure helpers (splitBibEntries,
// lightEntry, makeCitekey, dedup-by-DOI) so the two paths can't drift. v1 covers
// what the GUI needs: add-via-DOI, add-to-library, materialize, reconcile-on-open.
// (No index/search here — the editor searches the in-memory project subset; a
// FluxLib-wide search UI is future. The agent search tool lives in flux-core.)
import { fileBridge, joinPath, type ProjectManifest } from "../project/types";
import type { RefEntry, AddResult } from "./types";
import { splitBibEntries, lightEntry, bibtexKey } from "./bibtex";
import { planAdds, appendedBib } from "./addPlan";
import { bumpFluxLib, fluxLibEntries } from "./revision";
import { mergeEnrich, type EnrichMap, projectEnrichForGrid } from "./enrich";
import { createEnrichCache } from "./enrichStore";
import { pushToast } from "../toast";
import { withIpcLock } from "./libLock";

const SCHEMA_VERSION = "0.1.0";

const libBib = (lib: string) => joinPath(lib, "library.bib");
const libManifest = (lib: string) => joinPath(lib, "fluxlib.json");
const projectBibPath = (root: string, m?: ProjectManifest | null) =>
  joinPath(root, m?.references?.library ?? "references/library.bib");

async function prefsGet(): Promise<Record<string, unknown>> {
  const fb = fileBridge();
  try {
    return (fb?.prefsGet ? await fb.prefsGet() : {}) ?? {};
  } catch {
    return {};
  }
}
async function readTextSafe(p: string): Promise<string> {
  const fb = fileBridge();
  if (!fb) return "";
  try {
    return (await fb.exists(p)) ? await fb.readText(p) : "";
  } catch {
    return "";
  }
}
async function readManifest(root: string): Promise<ProjectManifest | null> {
  const t = await readTextSafe(joinPath(root, "project.json"));
  try {
    return t ? (JSON.parse(t) as ProjectManifest) : null;
  } catch {
    return null;
  }
}

/** The FluxLib path, or null without a bridge. Main owns the resolution
 *  (DERIVED: <FluxConfig>/FluxLib, legacy fallbacks pre-migration) and hands
 *  it to the renderer as prefs.fluxLibResolved — never resolve it here. */
export async function resolveFluxLibPath(): Promise<string | null> {
  const fb = fileBridge();
  if (!fb) return null;
  const resolved = (await prefsGet()).fluxLibResolved;
  if (typeof resolved === "string" && resolved.trim()) return resolved;
  const { home } = await fb.paths();
  return joinPath(home, "FluxConfig", "FluxLib");
}

/** Ensure FluxLib exists (mkdir + empty library.bib + fluxlib.json), migrating a
 *  legacy <userData>/references/library.bib seed once. Idempotent; returns the
 *  path (or null without a bridge). No path is persisted — FluxLib is derived
 *  from FluxConfig (pointer pref fluxConfigPath, owned by main's migration). */
export async function ensureFluxLib(): Promise<string | null> {
  const fb = fileBridge();
  if (!fb) return null;
  const lib = await resolveFluxLibPath();
  if (!lib) return null;
  await fb.mkdir(joinPath(lib, ".fluxlib"));
  // The watched drop-inbox must exist for anyone to drop PDFs into it.
  await fb.mkdir(joinPath(lib, "pdfs_to_assign"));
  if (!(await fb.exists(libBib(lib)))) {
    let seed = "";
    try {
      const { userData } = await fb.paths();
      const legacy = joinPath(userData, "references", "library.bib");
      if (await fb.exists(legacy)) {
        const t = (await fb.readText(legacy)).trimEnd();
        if (t) seed = t + "\n";
      }
    } catch {
      /* no legacy seed */
    }
    await fb.writeText(
      libBib(lib),
      seed || "% FluxLib — your machine-global reference library (BibLaTeX). Canonical source of truth.\n",
    );
  }
  if (!(await fb.exists(libManifest(lib)))) {
    await fb.writeText(
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

/** The current machine-global library.bib text (for an import preview via planAdds).
 *  Empty string when there's no bridge/library yet. */
export async function readLibraryBibText(): Promise<string> {
  const fb = fileBridge();
  if (!fb) return "";
  const lib = await resolveFluxLibPath();
  if (!lib) return "";
  return readTextSafe(libBib(lib));
}

/** Add BibTeX to FluxLib, deduping by DOI. Mirrors flux-core/fluxlib.ts addToFluxLib.
 *  W3: the read→dedupe→append→write runs under the FluxLib "library" lock, so a
 *  concurrent CLI/MCP lib-add can no longer race this into a lost entry. */
export async function addToFluxLib(
  bibtex: string,
  opts: { source?: "doi" | "bibtex" } = {},
): Promise<AddResult> {
  const fb = fileBridge();
  const empty: AddResult = { added: [], deduped: [], keys: [] };
  if (!fb) return empty;
  const source = opts.source ?? "bibtex";
  const lib = await ensureFluxLib();
  if (!lib) return empty;
  return withIpcLock("fluxlib", "library", () => addToFluxLibLocked(fb, lib, bibtex, source));
}

async function addToFluxLibLocked(
  fb: NonNullable<ReturnType<typeof fileBridge>>,
  lib: string,
  bibtex: string,
  source: "doi" | "bibtex",
): Promise<AddResult> {
  const curText = await readTextSafe(libBib(lib));
  // The dedupe/rekey decision (DOI, then title+year+author signature, incl. intra-batch)
  // lives in the shared pure planner so preview == outcome; this twin only does the write.
  const plan = planAdds(curText, bibtex, source);
  if (plan.appendText) {
    await fb.writeText(libBib(lib), appendedBib(curText, plan));
    bumpFluxLib();
  }
  return { added: plan.added, deduped: plan.deduped, keys: plan.keys };
}

/** Remove entries from FluxLib by citekey. Each entry's raw block is spliced out of
 *  library.bib verbatim (preserving the header comment and any other text), under the
 *  same "library" lock as addToFluxLib. The keys' enrich-sidecar rows are dropped too
 *  (rebuildable), but items/<key>/ (PDF, notes, annotations) is deliberately left on
 *  disk — re-adding the paper under the same key re-attaches it. Returns the removed
 *  entries (with their raw BibTeX) so callers can offer Undo via addToFluxLib. */
export async function removeFromFluxLib(citekeys: string[]): Promise<{ removed: RefEntry[] }> {
  const fb = fileBridge();
  if (!fb || !citekeys.length) return { removed: [] };
  const lib = await ensureFluxLib();
  if (!lib) return { removed: [] };
  const want = new Set(citekeys);
  const removed = await withIpcLock("fluxlib", "library", async () => {
    let text = await readTextSafe(libBib(lib));
    const out: RefEntry[] = [];
    for (const raw of splitBibEntries(text)) {
      const k = bibtexKey(raw);
      if (!k || !want.has(k)) continue;
      const at = text.indexOf(raw);
      if (at < 0) continue;
      let end = at + raw.length; // swallow the blank line the removal leaves behind
      while (end < text.length && (text[end] === "\n" || text[end] === "\r")) end++;
      text = text.slice(0, at) + text.slice(end);
      out.push(lightEntry(raw));
    }
    if (out.length) await fb.writeText(libBib(lib), text);
    return out;
  });
  if (removed.length) {
    // Drop the sidecar rows under the enrich lock (best-effort — the sidecar is derived).
    // Fresh read INSIDE the lock (never the cache), invalidate after the write.
    try {
      await withIpcLock("fluxlib", "enrich", async () => {
        const map = await loadEnrichMapFresh();
        let dirty = false;
        for (const e of removed) {
          if (map[e.key]) {
            delete map[e.key];
            dirty = true;
          }
        }
        if (dirty) {
          await fb.writeText(libEnrich(lib), JSON.stringify(map, null, 2) + "\n");
          // WS-8.3: keep the grid projection in lockstep (written AFTER the
          // full file — the freshness rule is grid.mtime ≥ full.mtime).
          await fb.writeText(libEnrichGrid(lib), JSON.stringify(projectEnrichForGrid(map)) + "\n");
          invalidateEnrichCache();
        }
      });
    } catch {
      /* stale sidecar rows are harmless — mergeEnrich joins by existing keys only */
    }
    bumpFluxLib();
  }
  return { removed };
}

/** Load every FluxLib entry as RefEntry[] for the Library window. Uses the cheap,
 *  dependency-free lightEntry path (the SAME one addToFluxLib/reconcile use), so the
 *  window and the writers can't drift. Returns [] without a bridge. */
export async function loadFluxLib(): Promise<RefEntry[]> {
  const lib = await resolveFluxLibPath();
  if (!lib) return [];
  const text = await readTextSafe(libBib(lib));
  return splitBibEntries(text)
    .map(lightEntry)
    .filter((e) => e.key);
}

const libEnrich = (lib: string) => joinPath(lib, ".fluxlib", "enrich.json");
const libEnrichGrid = (lib: string) => joinPath(lib, ".fluxlib", "enrich-grid.json");

/** Read + parse the enrichment sidecar FRESH from disk (`{}` if absent / no bridge).
 *  Derived + rebuildable — the renderer twin of fluxlib.ts loadEnrich.
 *  W2: an unparseable file is quarantined as `.corrupt-<ts>` + toasted — never
 *  silently treated as empty (which used to wipe the cache on the next write).
 *  Use this ONLY inside a locked read-modify-write (freshest bytes under the lock,
 *  then invalidateEnrichCache() after writing); every read path goes through the
 *  cached loadEnrichMap() below. */
export async function loadEnrichMapFresh(): Promise<EnrichMap> {
  const lib = await resolveFluxLibPath();
  if (!lib) return {};
  const p = libEnrich(lib);
  const t = await readTextSafe(p);
  try {
    return t ? (JSON.parse(t) as EnrichMap) : {};
  } catch {
    const fb = fileBridge();
    const q = `${p}.corrupt-${Date.now()}`;
    try {
      await fb?.writeText(q, t ?? "");
      await fb?.remove?.(p);
    } catch {
      /* best-effort quarantine */
    }
    pushToast("error", "Enrichment cache was corrupt", {
      detail: `Quarantined to ${q.split("/").pop()} — run Enrich again to rebuild`,
    });
    return {};
  }
}

// The shared mtime-keyed parse cache (B1): one resident map, one parse per actual
// file change, shared by the Library grid, per-key lookups (reader references,
// citing/similar/author), and the editor's fluxLibEntries refresh.
const enrichCache = createEnrichCache({
  // WS-8.3: display paths read the GRID projection (~an order of magnitude
  // smaller parse) whenever it is at least as fresh as the full sidecar;
  // stale/missing/corrupt grid falls back to the full parse. Locked writers
  // never read through here (loadEnrichMapFresh stays full-file).
  path: async () => {
    const lib = await resolveFluxLibPath();
    if (!lib) return null;
    const fb = fileBridge();
    const grid = libEnrichGrid(lib);
    const full = libEnrich(lib);
    if (!fb?.stat) return full;
    try {
      const [gs, fs] = await Promise.all([fb.stat(grid), fb.stat(full)]);
      if (gs && (!fs || gs.mtimeMs >= fs.mtimeMs)) return grid;
    } catch {
      /* stat trouble → full file */
    }
    return full;
  },
  stat: async (p) => {
    const fb = fileBridge();
    if (!fb?.stat) return null;
    return fb.stat(p);
  },
  load: async (p) => {
    if (p.endsWith("enrich-grid.json")) {
      try {
        const t = await readTextSafe(p);
        if (t) return JSON.parse(t) as EnrichMap;
      } catch {
        /* corrupt grid is disposable — fall through to the full parse */
      }
    }
    return loadEnrichMapFresh();
  },
});

/** The enrichment map, served from the mtime-keyed cache (a parse happens only when
 *  enrich.json actually changed). Same signature/behavior as the old direct loader. */
export function loadEnrichMap(): Promise<EnrichMap> {
  return enrichCache.get();
}

/** Drop the cached map — call after ANY write to enrich.json (hydrate merge, entry
 *  removal) and on watcher events for it, so the next read re-parses. */
export function invalidateEnrichCache(): void {
  enrichCache.invalidate();
}

/** Refresh the shared `fluxLibEntries` store from disk, joined with enrichment (so the
 *  margin search, omnibox, and @-autocomplete can match/show abstracts, topics, and
 *  citation counts). Call on mount + on every fluxLibRevision bump. */
export async function refreshFluxLib(): Promise<void> {
  const [entries, map] = await Promise.all([loadFluxLib(), loadEnrichMap()]);
  fluxLibEntries.set(mergeEnrich(entries, map));
}

/** Append FluxLib entries for `citekeys` into the project's library.bib (idempotent). */
export async function materializeIntoProject(
  root: string,
  citekeys: string[],
  opts: { manifest?: ProjectManifest | null } = {},
): Promise<{ added: string[] }> {
  const fb = fileBridge();
  if (!fb || !citekeys.length) return { added: [] };
  const lib = await resolveFluxLibPath();
  if (!lib) return { added: [] };
  const libText = await readTextSafe(libBib(lib));
  const libRawByKey = new Map<string, string>();
  for (const r of splitBibEntries(libText)) {
    const k = bibtexKey(r);
    if (k) libRawByKey.set(k, r);
  }
  const manifest = opts.manifest ?? (await readManifest(root));
  const pbib = projectBibPath(root, manifest);
  // W3: the project-bib append is an RMW — locked ("references") against
  // flux-core's materialize/reconcile running concurrently.
  return withIpcLock("project", "references", async () => {
    const projText = await readTextSafe(pbib);
    const projKeys = new Set(splitBibEntries(projText).map(bibtexKey).filter(Boolean) as string[]);

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
      await fb.writeText(pbib, projText + sep + toAdd.join("\n\n") + "\n");
    }
    return { added: addedKeys };
  });
}

const CITE_RE = /@([A-Za-z][\w:.-]*)/g;
const isCrossref = (k: string) => /^(?:fig|tbl|sec|eq)-/.test(k);
function citedKeysIn(text: string): string[] {
  const out = new Set<string>();
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(text))) if (!isCrossref(m[1])) out.add(m[1]);
  return [...out];
}

/** Reconcile a project against FluxLib on open: promote project-local-only cited
 *  entries up, materialize the rest, report orphans. Non-destructive. Mirrors the
 *  flux-core engine. */
export async function reconcileProject(
  root: string,
): Promise<{ materialized: string[]; promoted: string[]; orphans: string[] }> {
  const none = { materialized: [] as string[], promoted: [] as string[], orphans: [] as string[] };
  const fb = fileBridge();
  if (!fb) return none;
  const lib = await ensureFluxLib();
  if (!lib) return none;
  const manifest = await readManifest(root);
  const docs = manifest
    ? ([manifest.manuscript?.path, ...(manifest.supplementary ?? []).map((s) => s.path)].filter(
        Boolean,
      ) as string[])
    : ["manuscript/main.qmd"];
  const cited = new Set<string>();
  for (const rel of docs) citedKeysIn(await readTextSafe(joinPath(root, rel))).forEach((k) => cited.add(k));
  if (!cited.size) return none;

  const libKeys = new Set(
    splitBibEntries(await readTextSafe(libBib(lib)))
      .map(bibtexKey)
      .filter(Boolean) as string[],
  );
  const projText = await readTextSafe(projectBibPath(root, manifest));
  const projRawByKey = new Map<string, string>();
  for (const r of splitBibEntries(projText)) {
    const k = bibtexKey(r);
    if (k) projRawByKey.set(k, r);
  }
  const promoted: string[] = [];
  for (const k of cited) {
    if (!libKeys.has(k) && projRawByKey.has(k)) {
      await addToFluxLib(projRawByKey.get(k) as string, { source: "bibtex" });
      libKeys.add(k);
      promoted.push(k);
    }
  }
  const { added } = await materializeIntoProject(root, [...cited], { manifest });
  const orphans = [...cited].filter((k) => !libKeys.has(k) && !projRawByKey.has(k));
  return { materialized: added, promoted, orphans };
}
