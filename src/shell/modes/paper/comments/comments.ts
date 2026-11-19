// Margin-comment data layer (Flux_Paper_Plan.md C1). Threads live in a sibling
// `manuscript/comments.json` — never in the .qmd (Principle 6). Anchors use a
// W3C-style TextQuoteSelector so comments re-anchor after out-of-app edits: exact
// offset first, else a fuzzy search (approx-string-match, the primitive
// Hypothesis uses) disambiguated by prefix/suffix + proximity, else detached.

import search from "approx-string-match";
import { fileBridge, joinPath, type LoadedProject } from "../../../../lib/project/types";
import { commentsSidecarRel, commentsMainPath } from "../../../../lib/project/docOrder";

import { mergeCommentThreads, rebaseCommentThreads, type CommentsFile, type CommentThread, type TextQuoteSelector } from "../../../../lib/project/comments";
import { withIpcLock } from "../../../../lib/references/libLock";
import { commentFiles, bumpComments } from "../../../../lib/project/commentBridge";
export type { CommentMessage, CommentThread, TextQuoteSelector } from "../../../../lib/project/comments";

const CTX = 32; // chars of prefix/suffix context kept for re-anchoring

export function makeAnchor(doc: string, from: number, to: number): TextQuoteSelector {
  return {
    start: from,
    end: to,
    quote: doc.slice(from, to),
    prefix: doc.slice(Math.max(0, from - CTX), from),
    suffix: doc.slice(to, Math.min(doc.length, to + CTX)),
  };
}

/** Re-locate an anchor in the current doc. Returns null when genuinely lost. */
export function resolveAnchor(
  doc: string,
  a: TextQuoteSelector,
): { from: number; to: number } | null {
  if (!a.quote) return null;
  // Fast path: the offsets still hold the exact quote.
  if (doc.slice(a.start, a.end) === a.quote) return { from: a.start, to: a.end };

  // Fuzzy: allow up to ~25% edits, then disambiguate by context + proximity.
  const maxErrors = Math.min(a.quote.length, Math.max(1, Math.floor(a.quote.length * 0.25)));
  let matches: { start: number; end: number; errors: number }[] = [];
  try {
    matches = search(doc, a.quote, maxErrors);
  } catch {
    return null;
  }
  if (!matches.length) return null;

  let best = matches[0];
  let bestScore = -Infinity;
  for (const m of matches) {
    const pre = doc.slice(Math.max(0, m.start - CTX), m.start);
    const suf = doc.slice(m.end, m.end + CTX);
    const ctxScore =
      commonSuffix(pre, a.prefix) + commonPrefix(suf, a.suffix) - m.errors * 2;
    const proximity = -Math.abs(m.start - a.start) / 1000;
    const score = ctxScore + proximity;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { from: best.start, to: best.end };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

// ---- persistence ----------------------------------------------------------
// Comments live beside their document (Principle 6). The main manuscript keeps
// the historical `comments.json`; other documents get `<base>.comments.json` so
// each F4 document has its own thread set.
export async function readComments(p: LoadedProject, docRel?: string): Promise<CommentThread[]> {
  const fb = fileBridge();
  if (!fb) return [];
  try {
    return mergeCommentThreads((await commentFiles(p.root, p.manifest, docRel ?? p.manifest.manuscript.path)).map(f => f.file));
  } catch { return []; }
}

/**
 * Save an open document's threads, merged with whatever is on disk now (`rebaseCommentThreads`
 * against `base`, the threads this editor last read or wrote), under the same `manuscript`
 * operation lease flux-core's reply/resolve/comment writers hold. So an agent's reply that
 * landed after the editor last loaded — even inside the watcher's settle window, before the
 * editor could hear of it — is kept, not overwritten. Returns the threads as written.
 */
export async function writeComments(
  p: LoadedProject,
  threads: CommentThread[],
  docRel: string | undefined,
  base: readonly CommentThread[] | null,
): Promise<CommentThread[]> {
  const fb = fileBridge();
  if (!fb) return threads;
  const doc = docRel ?? p.manifest.manuscript.path;
  const written = await withIpcLock("project", "manuscript", async lease => {
    const files: { rel: string; file: CommentsFile; text?: string }[] = await commentFiles(p.root, p.manifest, doc);
    const merged = rebaseCommentThreads(base, threads, mergeCommentThreads(files.map(f => f.file)));
    const known = new Set(files.flatMap(f => f.file.threads.map(t => t.id)));
    if (!files.length) files.push({ rel: commentsSidecarRel(commentsMainPath(p.manifest), doc), file: { version: 1, threads: [] } });
    for (const [i, { rel, file, text }] of files.entries()) {
      const owned = new Set(file.threads.map(t => t.id));
      const next = { ...file, threads: merged.filter(t => owned.has(t.id) || (i === 0 && !known.has(t.id))) };
      const out = JSON.stringify(next, null, 2) + "\n";
      if (out === text) continue; // byte-identical rewrites are skipped
      await lease.assertOwned?.();
      await fb.writeText(joinPath(p.root, rel), out);
    }
    return merged;
  }, { root: p.root, retries: 40 });
  bumpComments();
  return written;
}

export function newId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
