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
// Freshness is per-document staleness-DELTA, not write hooks: every load stats
// items/*/fulltext.txt (stat-only — no reads), re-tokenizes only new/changed
// docs, purges deleted ones, and persists when anything moved. That covers the
// flux-core writers AND the renderer's bridge writes uniformly, with no IPC.
// No SQLite/FTS5: native ABIs are outside the repo posture (npmRebuild:false).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite } from "./fsx";
import { foldText } from "../src/lib/references/textFold";

export interface FulltextIndexDoc {
  mtimeMs: number;
  pages: number;
}
export interface FulltextIndexFile {
  schemaVersion: 1;
  builtAt: string;
  docs: Record<string, FulltextIndexDoc>;
  /** foldedToken → { key → 1-based page numbers } */
  postings: Record<string, Record<string, number[]>>;
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
  return { schemaVersion: 1, builtAt: new Date().toISOString(), docs: {}, postings: {} };
}

// One resident index per library path, keyed by the persisted file's identity
// so external rebuilds are picked up.
const resident = new Map<string, { fileKey: string; idx: FulltextIndexFile }>();

async function statKey(p: string): Promise<string> {
  try {
    const st = await fs.stat(p);
    return `${st.mtimeMs}:${st.size}`;
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

/** Load the index and delta-refresh it against the items tree (stat-only for
 *  fresh docs; re-tokenize only new/changed; purge deleted; persist if moved). */
export async function loadFreshFulltextIndex(libPath: string): Promise<FreshIndex | null> {
  const L = path.resolve(libPath);
  const itemsDir = path.join(L, "items");
  const idxPath = path.join(L, INDEX_REL);
  let dirents;
  try {
    dirents = (await fs.readdir(itemsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return null; // no items/ yet — nothing to index
  }

  // Resident fast path (same persisted file → same in-memory index).
  const fk = await statKey(idxPath);
  let idx: FulltextIndexFile | null = null;
  const cached = resident.get(L);
  if (cached && cached.fileKey === fk) idx = cached.idx;
  if (!idx && fk !== "absent") {
    try {
      const parsed = JSON.parse(await fs.readFile(idxPath, "utf8")) as FulltextIndexFile;
      if (parsed && parsed.schemaVersion === 1 && parsed.docs && parsed.postings) idx = parsed;
    } catch {
      idx = null; // corrupt → rebuild below
    }
  }
  if (!idx) idx = emptyIndex();

  // Staleness delta: stat every fulltext.txt (no reads), re-tokenize only what moved.
  const missingText: string[] = [];
  const dirOrder: string[] = [];
  const live = new Set<string>();
  let changed = false;
  for (const e of dirents) {
    const key = e.name.normalize("NFC");
    dirOrder.push(key);
    const ftPath = path.join(itemsDir, e.name, "fulltext.txt");
    let st;
    try {
      st = await fs.stat(ftPath);
    } catch {
      // No text. Track for the backfill list only when a PDF exists.
      try {
        await fs.access(path.join(itemsDir, e.name, "paper.pdf"));
        missingText.push(key);
      } catch {
        /* no pdf either */
      }
      if (idx.docs[key]) {
        purgeDoc(idx, key);
        changed = true;
      }
      continue;
    }
    live.add(key);
    const rec = idx.docs[key];
    if (rec && rec.mtimeMs === st.mtimeMs) continue; // fresh
    // New/changed → (re)tokenize this one document.
    let folded: string;
    try {
      folded = foldText(await fs.readFile(ftPath, "utf8"));
    } catch {
      continue;
    }
    if (rec) purgeDoc(idx, key);
    const toks = tokenizePages(folded);
    idx.docs[key] = { mtimeMs: st.mtimeMs, pages: folded.split("\f").length };
    for (const [tok, pages] of toks) {
      (idx.postings[tok] ??= {})[key] = [...pages];
    }
    changed = true;
  }
  for (const key of Object.keys(idx.docs)) {
    if (!live.has(key)) {
      purgeDoc(idx, key);
      changed = true;
    }
  }

  if (changed) {
    idx.builtAt = new Date().toISOString();
    await atomicWrite(idxPath, JSON.stringify(idx) + "\n").catch(() => {});
  }
  resident.set(L, { fileKey: await statKey(idxPath), idx });
  return { idx, missingText, dirOrder };
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
    acc = acc === null ? docs : new Set([...acc].filter((k) => docs.has(k)));
    if (!acc.size) return acc;
  }
  return acc ?? new Set();
}
