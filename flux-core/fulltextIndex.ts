import { prepareItemLocators } from "./itemLocators";
import { itemKey } from "../src/lib/references/itemLocator";
import { itemDir } from "../src/lib/references/items";
import { fulltextIsCurrent, pdfIdentityAt } from "./itemGeneration";
// WS-8.4 (fortify plan) — the persistent pure-JS full-text index behind
// searchFulltext's existing seam (.fluxlib/fulltext-index.json). The linear
// scan's semantics are SUBSTRING includes over folded text, so the index is a
// CANDIDATE FILTER, never the verdict: token postings + a vocabulary substring
// lookup nominate documents, and the caller runs the exact per-document match
// (read + folded includes + snippets) on candidates only. Queries the index
// cannot answer conservatively (any needle with punctuation/whitespace beyond
// a plain [a-z0-9]+ term) report null and the caller falls back to the scan —
// the text on disk stays the truth; this file is derived and rebuildable.
//
// CLI/MCP reads verify the full tree. A resident worker consumes native watcher
// candidates and a bounded rotating integrity scan, retaining the same exact
// matching policy. Missed events are repaired without statting all items for
// every keystroke. Derived index corruption always triggers a complete rebuild.
// No SQLite/FTS5: native ABIs are outside the repo posture (npmRebuild:false).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./fsx";
import { foldForMatch } from "../src/lib/references/textFold";

export interface FulltextIndexDoc {
  mtimeMs: number;
  ctimeMs?: number;
  size?: number;
  pages: number;
}
export interface FulltextIndexFile {
  /** Bump whenever the FOLDING changes: the postings are derived from folded text, so an index
   *  built under the old rules would nominate candidates the matcher no longer agrees with.
   *  3 = separator-collapsing fold plus verified derived-cache integrity. */
  schemaVersion: 3;
  builtAt: string;
  docs: Record<string, FulltextIndexDoc>;
  /** foldedToken → { key → 1-based page numbers } */
  postings: Record<string, Record<string, number[]>>;
  integrity?: string;
}

const INDEX_REL = path.join(".fluxlib", "fulltext-index.json");
const TOKEN_RE = /[a-z0-9]+/g;
const MIN_TOKEN = 2;

/** A needle the index can answer conservatively: one clean folded token-ish
 *  term (no spaces/punctuation). Anything else → linear scan. */
export const isIndexableNeedle = (n: string): boolean => /^[a-z0-9]{2,}$/.test(n);

function tokenizePages(folded: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const pages = folded.split("\f");
  for (let p = 0; p < pages.length; p++) {
    TOKEN_RE.lastIndex = 0;
    for (const m of pages[p].matchAll(TOKEN_RE)) {
      const tok = m[0];
      if (tok.length < MIN_TOKEN) continue;
      let s = out.get(tok);
      if (!s) out.set(tok, (s = new Set()));
      s.add(p + 1);
    }
  }
  return out;
}

function emptyIndex(): FulltextIndexFile {
  return { schemaVersion: 3, builtAt: new Date().toISOString(), docs: Object.create(null), postings: Object.create(null) };
}

function indexBody(idx: FulltextIndexFile): string {
  return JSON.stringify({schemaVersion:idx.schemaVersion,builtAt:idx.builtAt,docs:idx.docs,postings:idx.postings});
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function checkedIndex(value: unknown): FulltextIndexFile | null {
  if (!record(value) || value.schemaVersion !== 3 || typeof value.builtAt !== "string" || !record(value.docs) || !record(value.postings) || typeof value.integrity !== "string") return null;
  for (const doc of Object.values(value.docs)) {
    if (!record(doc) || !Number.isFinite(doc.mtimeMs) || !Number.isFinite(doc.ctimeMs) || !Number.isSafeInteger(doc.size) || doc.size < 0 || !Number.isSafeInteger(doc.pages) || doc.pages < 1) return null;
  }
  for (const [token, docs] of Object.entries(value.postings)) {
    if (!/^[a-z0-9]{2,}$/.test(token) || !record(docs)) return null;
    for (const [key, pages] of Object.entries(docs)) {
      if (!Object.hasOwn(value.docs,key) || !Array.isArray(pages) || !pages.length || pages.some((page,i)=>!Number.isSafeInteger(page)||page<1||page>value.docs[key].pages||(i>0&&page<=pages[i-1]))) return null;
    }
  }
  if (digest(indexBody(value as FulltextIndexFile)) !== value.integrity) return null;
  // User words/citekeys are data, including constructor/toString/__proto__.
  const idx=value as FulltextIndexFile;
  idx.docs=Object.assign(Object.create(null),idx.docs);
  idx.postings=Object.assign(Object.create(null),idx.postings);
  for (const token of Object.keys(idx.postings)) idx.postings[token]=Object.assign(Object.create(null),idx.postings[token]);
  return idx;
}

// One resident index per library path, keyed by the persisted file's identity
// so external rebuilds are picked up.
const resident = new Map<string, { fileKey: string; idx: FulltextIndexFile }>();

async function statKey(p: string): Promise<string> {
  try {
    const st = await fs.stat(p);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "absent";
  }
}

function purgeDoc(idx: FulltextIndexFile, key: string): void {
  delete idx.docs[key];
  for (const tok of Object.keys(idx.postings)) {
    const perDoc = idx.postings[tok];
    if (perDoc[key]) {
      delete perDoc[key];
      if (!Object.keys(perDoc).length) delete idx.postings[tok];
    }
  }
}

export interface FreshIndex {
  idx: FulltextIndexFile;
  /** dir names (NFC) that have a PDF but no fulltext.txt — the backfill list. */
  missingText: string[];
  /** all item dir names in readdir order (the scan's iteration order). */
  dirOrder: string[];
}

export interface FulltextProgress { phase: "checking" | "indexing" | "searching"; completed: number; total: number }
/** Owned by one sequential worker, never shared across libraries or main. */
export interface FulltextRefreshState {
  dirs: string[] | null;
  dirty: Set<string>;
  missing: Set<string>;
  cursor: number;
  discover: boolean;
  full: boolean;
  discoveryAt: number;
  /** Bounded observations for acceptance/diagnostics, not persisted data. */
  lastChecked: number;
  integrityBatch: number;
}
export function createFulltextRefreshState(integrityBatch = 128): FulltextRefreshState {
  return { dirs: null, dirty: new Set(), missing: new Set(), cursor: 0, discover: true, full: true, discoveryAt: 0, lastChecked: 0, integrityBatch: Math.max(1, Math.min(512, integrityBatch)) };
}
export function markFulltextDirty(state: FulltextRefreshState, relativePath: string | null): void {
  const parts = relativePath?.split(/[\\/]/);
  if (parts?.[0] === "items" && parts[1] && parts[1] !== "." && parts[1] !== "..") {
    state.dirty.add(parts[1]);
    if (parts.length === 2 || !state.dirs?.includes(parts[1])) state.discover = true;
  } else {
    // Watcher loss, library identity/locator changes, and a foreign index rebuild
    // require a fresh discovery. A cache is never an authority for missing data.
    state.discover = true;
    state.full = true;
  }
}

/** Load the index and delta-refresh it against the items tree (stat-only for
 *  fresh docs; re-tokenize only new/changed; purge deleted; persist if moved). */
export async function loadFreshFulltextIndex(libPath: string, options: { refresh?: FulltextRefreshState; onProgress?: (p: FulltextProgress) => void } = {}): Promise<FreshIndex | null> {
  const L = path.resolve(libPath);
  const state = options.refresh;
  const itemsDir = path.join(L, "items");
  const idxPath = path.join(L, INDEX_REL);
  let dirs = state?.dirs ?? null;
  const discover = !dirs || !state || state.discover || Date.now() - state.discoveryAt >= 30000;
  if (discover) {
    // Clear before awaits: a new event during this read remains pending.
    if (state) state.discover = false;
    await prepareItemLocators(L);
    try { dirs = (await fs.readdir(itemsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (state) { state.dirs = null; state.full = true; }
      return null;
    }
    if (state) { state.dirs = dirs; state.discoveryAt = Date.now(); }
  }
  const names = dirs!;

  // Resident fast path (same persisted file → same in-memory index).
  const fk = await statKey(idxPath);
  let idx: FulltextIndexFile | null = null;
  const cached = resident.get(L);
  if (cached && cached.fileKey === fk) idx = cached.idx;
  const complete = !state || state.full || !idx;
  if (state) state.full = false;
  if (!idx && fk !== "absent") {
    try {
      if ((await fs.stat(idxPath)).size <= 512 * 1024 * 1024) idx = checkedIndex(JSON.parse(await fs.readFile(idxPath, "utf8")));
    } catch {
      idx = null; // corrupt → rebuild below
    }
  }
  const rebuild = !idx;
  if (!idx) idx = emptyIndex();

  // Staleness delta: inspect selected source identities and re-tokenize changes.
  const missing = state?.missing ?? new Set<string>();
  if (complete) missing.clear();
  const dirOrder = names.map(name => itemKey(L, name));
  const live = new Set(dirOrder);
  const pending = state ? [...state.dirty] : [];
  state?.dirty.clear();
  const selected = new Set<string>(complete ? names : pending);
  if (state && !complete && names.length) {
    for (let i = 0; i < Math.min(state.integrityBatch, names.length); i++) {
      selected.add(names[state.cursor % names.length]);
      state.cursor = (state.cursor + 1) % names.length;
    }
  }
  // Newly discovered items always join this refresh, even if their watcher
  // event was missed. Deleted items are removed below using the full directory list.
  if (discover && !complete) for (const name of names) {
    const key = itemKey(L, name);
    if (!idx.docs[key] && !missing.has(key)) selected.add(name);
  }
  const selectedNames = [...selected].filter(name => names.includes(name));
  if (state) state.lastChecked = selectedNames.length;
  const progress = (phase: FulltextProgress["phase"], completed: number, total: number) => options.onProgress?.({phase, completed, total});
  progress("checking", 0, selectedNames.length);
  let changed = rebuild;
  // Filesystem freshness probes are independent. Bounded parallelism avoids
  // five serial round trips per document on every resident-worker query.
  const checks: {key:string;ftPath:string;st:{mtimeMs:number;ctimeMs:number;size:number}|null;hasPdf:boolean}[] = new Array(selectedNames.length);
  let next = 0, checked = 0;
  await Promise.all(Array.from({length:Math.min(12,selectedNames.length)},async()=>{
    while(next<selectedNames.length){
      const i=next++, name=selectedNames[i], key=itemKey(L,name), dir=path.join(itemsDir,name), ftPath=path.join(dir,"fulltext.txt");
      let st:{mtimeMs:number;ctimeMs:number;size:number}|null=null, hasPdf=false;
      try { if(await fulltextIsCurrent(dir)) st=await fs.stat(ftPath); } catch { /* missing/stale text is a backfill candidate */ }
      if(!st) hasPdf=!!await pdfIdentityAt(dir).catch(()=>null);
      checks[i]={key,ftPath,st,hasPdf};
      checked++;
      if (checked % 32 === 0 || checked === selectedNames.length) progress("checking", checked, selectedNames.length);
    }
  }));
  let indexed = 0;
  for (const {key,ftPath,st,hasPdf} of checks) {
    indexed++;
    if (!st) {
      if(hasPdf) missing.add(key); else missing.delete(key);
      if (idx.docs[key]) { purgeDoc(idx,key); changed=true; }
      continue;
    }
    missing.delete(key);
    const rec = idx.docs[key];
    if (rec && rec.mtimeMs === st.mtimeMs && rec.ctimeMs === st.ctimeMs && rec.size === st.size) continue; // fresh
    // New/changed → (re)tokenize this one document.
    let folded: string;
    try {
      // Tokenize the SAME folded form the matcher searches, or the index would nominate
      // candidates by different rules than matchDoc verifies them with.
      folded = foldForMatch(await fs.readFile(ftPath, "utf8")).text;
    } catch {
      continue;
    }
    if (rec) purgeDoc(idx, key);
    const toks = tokenizePages(folded);
    idx.docs[key] = { mtimeMs: st.mtimeMs, ctimeMs:st.ctimeMs, size:st.size, pages: folded.split("\f").length };
    for (const [tok, pages] of toks) {
      (idx.postings[tok] ??= Object.create(null))[key] = [...pages];
    }
    changed = true;
    if (indexed % 16 === 0 || indexed === checks.length) {
      progress("indexing", indexed, checks.length);
      // Deliver progress and dirty messages during a cold rebuild; this is
      // worker scheduling, never a delay on the renderer's query input.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  for (const key of missing) if (!live.has(key)) missing.delete(key);
  for (const key of Object.keys(idx.docs)) {
    if (!live.has(key)) {
      purgeDoc(idx, key);
      changed = true;
    }
  }

  if (changed) {
    idx.builtAt = new Date().toISOString();
    const body=indexBody(idx);
    idx.integrity=digest(body);
    await atomicWrite(idxPath, `${body.slice(0,-1)},"integrity":"${idx.integrity}"}\n`).catch(() => {});
  }
  resident.set(L, { fileKey: await statKey(idxPath), idx });
  return { idx, missingText: dirOrder.filter(key => missing.has(key)), dirOrder };
}

/** Candidate documents for a set of CLEAN needles (every needle must be
 *  isIndexableNeedle). A doc qualifies when, for EVERY needle, some vocabulary
 *  token CONTAINING the needle as a substring appears in the doc — the
 *  conservative superset of `folded.includes(needle)` for space-free needles.
 *  Returns null when any needle is unindexable (caller falls back to the scan). */
export function candidateDocs(idx: FulltextIndexFile, needles: string[]): Set<string> | null {
  if (!needles.length || !needles.every(isIndexableNeedle)) return null;
  let acc: Set<string> | null = null;
  const vocab = Object.keys(idx.postings);
  for (const n of needles) {
    const docs = new Set<string>();
    for (const tok of vocab) {
      if (!tok.includes(n)) continue;
      for (const key of Object.keys(idx.postings[tok])) docs.add(key);
    }
    if (acc === null) acc = docs;
    else { const prior: Set<string> = acc; acc = new Set(Array.from(prior).filter(k => docs.has(k))); }
    if (!acc.size) return acc;
  }
  return acc ?? new Set();
}
