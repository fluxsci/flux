// Full-text search across the library's stored PDFs (2.3) — the extracted text has
// sat on disk (items/<key>/fulltext.txt, written on every acquisition) with NOTHING
// reading it; "which of my 1,000 PDFs mentions X" was unanswerable in-app.
//
// Architecture: a streaming scan — readdir items/, read each fulltext.txt with
// bounded concurrency, folded `indexOf` AND/phrase matching (shared textFold rules,
// NEVER regex over user input), early-exit at the hit limit. At today's scale
// (~1k papers / tens of MB) a warm scan is well under a second; the interface is
// deliberately index-shaped so a .fluxlib posting-list can slot in behind the same
// signature if 5k+ cold latency ever bites. No SQLite: native ABIs are out of the
// repo's posture (npmRebuild:false, prebuilt-only).
//
// Pages: fulltext.txt joins pages with form-feeds (flux-core/fulltext.ts), so a
// match's page number is 1 + the number of \f before its offset.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFluxLibPath } from "./fluxlib";
import { hasPdf } from "./items";
import { foldText, parseQueryTerms } from "../src/lib/references/textFold";
import { loadFreshFulltextIndex, candidateDocs } from "./fulltextIndex";

export interface FulltextSnippet {
  page: number; // 1-based
  text: string; // trimmed context around the first hit on that page
}

export interface FulltextHit {
  key: string; // citekey (item dir name, NFC)
  count: number; // total occurrences of the first term/phrase
  snippets: FulltextSnippet[];
}

export interface FulltextResult {
  hits: FulltextHit[];
  scanned: number; // fulltext files read
  missingText: string[]; // keys with a paper.pdf but no fulltext.txt (backfill candidates)
  truncated: boolean; // hit limit reached before the scan finished
  elapsedMs: number;
}

export interface FulltextOpts {
  keys?: string[]; // restrict to these citekeys (e.g. the Library's current filter)
  limit?: number; // max hits (papers), default 50
  snippetsPerPaper?: number; // default 3
  snippetChars?: number; // context length, default 240
  libPath?: string;
  /** WS-8.4 test escape: skip the index and run the original linear scan (the
   *  oracle the scale gate compares against). */
  forceScan?: boolean;
}

const CONCURRENCY = 8;

function pageOfOffset(folded: string, offset: number): number {
  let page = 1;
  for (let i = 0; i < offset; i++) if (folded.charCodeAt(i) === 12) page++;
  return page;
}

function snippetAround(original: string, folded: string, offset: number, len: number, chars: number): FulltextSnippet {
  // Clamp the context window to the match's own page (between the surrounding form-feeds)
  // so a snippet never bleeds a neighbouring page's text under this page's label.
  const pStart = folded.lastIndexOf("\f", offset - 1) + 1; // 0 when no preceding \f
  let pEnd = folded.indexOf("\f", offset + len);
  if (pEnd < 0) pEnd = folded.length;
  const half = Math.floor((chars - len) / 2);
  let from = Math.max(pStart, offset - half);
  let to = Math.min(pEnd, offset + len + half);
  // Snap outward to whitespace so words aren't chopped (bounded walk, kept within page).
  while (from > pStart && from > offset - half - 20 && !/\s/.test(original[from])) from--;
  while (to < pEnd && to < offset + len + half + 20 && !/\s/.test(original[to])) to++;
  const text = original
    .slice(from, to)
    .replace(/\f/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { page: pageOfOffset(folded, offset), text: (from > pStart ? "…" : "") + text + (to < pEnd ? "…" : "") };
}

/** Search every stored fulltext for ALL of the query's terms/phrases. */
export async function searchFulltext(query: string, opts: FulltextOpts = {}): Promise<FulltextResult> {
  const t0 = Date.now();
  const L = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const limit = opts.limit ?? 50;
  const perPaper = opts.snippetsPerPaper ?? 3;
  const chars = opts.snippetChars ?? 240;
  const { terms, phrases } = parseQueryTerms(query);
  const needles = [...phrases, ...terms];
  const result: FulltextResult = { hits: [], scanned: 0, missingText: [], truncated: false, elapsedMs: 0 };
  if (!needles.length) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  const itemsDir = path.join(L, "items");
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(itemsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    result.elapsedMs = Date.now() - t0;
    return result; // no items/ yet
  }
  const wanted = opts.keys ? new Set(opts.keys.map((k) => k.normalize("NFC"))) : null;

  // The exact per-document verdict — IDENTICAL for the index and scan paths
  // (the index only nominates candidates; this is the semantics).
  const matchDoc = (original: string, key: string): FulltextHit | null => {
    const folded = foldText(original);
    if (!needles.every((n) => folded.includes(n))) return null;
    const primary = needles[0];
    const snippets: FulltextSnippet[] = [];
    let count = 0;
    let at = folded.indexOf(primary);
    const seenPages = new Set<number>();
    while (at >= 0) {
      count++;
      if (snippets.length < perPaper) {
        const s = snippetAround(original, folded, at, primary.length, chars);
        if (!seenPages.has(s.page)) {
          seenPages.add(s.page);
          snippets.push(s);
        }
      }
      at = folded.indexOf(primary, at + primary.length);
    }
    return { key, count, snippets };
  };

  // --- WS-8.4: indexed path — postings nominate candidates, matchDoc decides ----
  if (!opts.forceScan) {
    const fresh = await loadFreshFulltextIndex(L).catch(() => null);
    const cands = fresh ? candidateDocs(fresh.idx, needles) : null;
    if (fresh && cands !== null) {
      result.missingText = wanted ? fresh.missingText.filter((k) => wanted.has(k)) : fresh.missingText.slice();
      for (const key of fresh.dirOrder) {
        if (!cands.has(key)) continue;
        if (wanted && !wanted.has(key)) continue;
        let original: string;
        try {
          original = await fs.readFile(path.join(itemsDir, key, "fulltext.txt"), "utf8");
        } catch {
          continue; // raced deletion — the next load purges it
        }
        result.scanned++;
        const hit = matchDoc(original, key);
        if (!hit) continue; // conservative candidate that fails exact matching
        result.hits.push(hit);
        if (result.hits.length >= limit) {
          // More candidates remained → same truncation semantics as the scan.
          result.truncated = fresh.dirOrder.indexOf(key) < fresh.dirOrder.length - 1;
          break;
        }
      }
      result.hits.sort((a, b) => b.count - a.count);
      if (result.hits.length > limit) {
        result.truncated = true;
        result.hits.length = limit;
      }
      result.elapsedMs = Date.now() - t0;
      return result;
    }
  }

  let i = 0;
  let stop = false;
  const worker = async (): Promise<void> => {
    while (!stop) {
      const name = dirs[i++];
      if (name === undefined) return;
      const key = name.normalize("NFC");
      if (wanted && !wanted.has(key)) continue;
      const ftPath = path.join(itemsDir, name, "fulltext.txt");
      let original: string;
      try {
        original = await fs.readFile(ftPath, "utf8");
      } catch {
        // No text — note it as a backfill candidate only if a PDF exists.
        if (await hasPdf(key, L).catch(() => false)) result.missingText.push(key);
        continue;
      }
      result.scanned++;
      const hit = matchDoc(original, key);
      if (!hit) continue;
      result.hits.push(hit);
      if (result.hits.length >= limit) {
        // Early-exit optimization: stop scanning once we have enough. `limit` is a
        // SOFT cap here — other in-flight workers may push a few more past this
        // check — so the hard cap + truncation flag is enforced after the join.
        stop = true;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length || 1) }, worker));

  // Keep the highest-count hits; over-limit means there was more to show (either
  // unscanned dirs after early-exit, or concurrent workers that overshot the cap).
  result.hits.sort((a, b) => b.count - a.count);
  if (result.hits.length > limit) {
    result.truncated = true;
    result.hits.length = limit;
  } else if (stop && i < dirs.length) {
    // Hit the cap exactly, but dirs remained unscanned → more may match.
    result.truncated = true;
  }
  result.elapsedMs = Date.now() - t0;
  return result;
}
