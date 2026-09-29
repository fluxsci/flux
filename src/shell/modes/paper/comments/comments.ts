// Margin-comment data layer (Flux_Paper_Plan.md C1). Threads live in a sibling
// `manuscript/comments.json` — never in the .qmd (Principle 6). Anchors use a
// W3C-style TextQuoteSelector so comments re-anchor after out-of-app edits: exact
// offset first, else a fuzzy search (approx-string-match, the primitive
// Hypothesis uses) disambiguated by prefix/suffix + proximity, else detached.

import search from "approx-string-match";
import { fileBridge, joinPath, type LoadedProject } from "../../../../lib/project/types";
import { commentsSidecarRel, commentsMainPath } from "../../../../lib/project/docOrder";

import { mergeCommentThreads, type CommentThread, type TextQuoteSelector } from "../../../../lib/project/comments";
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

export async function writeComments(
  p: LoadedProject,
  threads: CommentThread[],
  docRel?: string,
): Promise<void> {
  const fb = fileBridge();
  if (!fb) return;
  const files = await commentFiles(p.root, p.manifest, docRel ?? p.manifest.manuscript.path);
  const known = new Set(files.flatMap(f => f.file.threads.map(t => t.id)));
  if (!files.length) files.push({ rel: commentsSidecarRel(commentsMainPath(p.manifest), docRel ?? p.manifest.manuscript.path), file: { version: 1, threads: [] } });
  for (const [i, { rel, file }] of files.entries()) {
    const owned = new Set(file.threads.map(t => t.id));
    const next = { ...file, threads: threads.filter(t => owned.has(t.id) || (i === 0 && !known.has(t.id))) };
    await fb.writeText(joinPath(p.root, rel), JSON.stringify(next, null, 2) + "\n");
  }
  bumpComments();
}

export function newId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
