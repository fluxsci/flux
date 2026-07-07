// Renderer-side FluxLib adapter — the browser/Electron twin of flux-core/fluxlib.ts.
// The renderer can't use node:fs, so this mirrors that engine's orchestration over
// the FileBridge (window.fig), reusing the SAME pure helpers (splitBibEntries,
// lightEntry, makeCitekey, dedup-by-DOI) so the two paths can't drift. v1 covers
// what the GUI needs: add-via-DOI, add-to-library, materialize, reconcile-on-open.
// (No index/search here — the editor searches the in-memory project subset; a
// FluxLib-wide search UI is future. The agent search tool lives in flux-core.)
import { fileBridge, joinPath, type ProjectManifest } from "../project/types";
import type { RefEntry, AddResult } from "./types";
import { makeCitekey, dupeSignature } from "./citekey";
import { splitBibEntries, lightEntry, bibtexKey, rekeyBibtex } from "./bibtex";
import { bumpFluxLib, fluxLibEntries } from "./revision";
import { mergeEnrich, type EnrichMap } from "./enrich";
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
async function prefsSet(patch: Record<string, unknown>): Promise<void> {
  try {
    await fileBridge()?.prefsSet?.(patch);
  } catch {
    /* best-effort */
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

/** The configured FluxLib path (preferences → default ~/FluxLib), or null without a bridge. */
export async function resolveFluxLibPath(): Promise<string | null> {
  const fb = fileBridge();
  if (!fb) return null;
  const configured = (await prefsGet()).fluxLibPath;
  if (typeof configured === "string" && configured.trim()) return configured;
  const { home } = await fb.paths();
  return joinPath(home, "FluxLib");
}

/** Ensure FluxLib exists (mkdir + empty library.bib + fluxlib.json), migrating a
 *  legacy <userData>/references/library.bib seed once. Persists the path to prefs.
 *  Idempotent; returns the path (or null without a bridge). */
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
  if (!(await prefsGet()).fluxLibPath) await prefsSet({ fluxLibPath: lib });
  return lib;
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
    // LR-9: no DOI match — fall back to a normalized title+year+author signature, so a paper
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
    await fb.writeText(libBib(lib), curText + sep + appendBuf.join("\n\n") + "\n");
    bumpFluxLib();
  }
  return { added, deduped, keys };
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
    try {
      await withIpcLock("fluxlib", "enrich", async () => {
        const map = await loadEnrichMap();
        let dirty = false;
        for (const e of removed) {
          if (map[e.key]) {
            delete map[e.key];
            dirty = true;
          }
        }
        if (dirty) await fb.writeText(libEnrich(lib), JSON.stringify(map, null, 2) + "\n");
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

/** Load the enrichment sidecar (`<lib>/.fluxlib/enrich.json`); `{}` if absent / no bridge.
 *  Derived + rebuildable — the renderer twin of fluxlib.ts loadEnrich.
 *  W2: an unparseable file is quarantined as `.corrupt-<ts>` + toasted — never
 *  silently treated as empty (which used to wipe the cache on the next write). */
export async function loadEnrichMap(): Promise<EnrichMap> {
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
