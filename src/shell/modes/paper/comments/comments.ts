// Margin-comment data layer (Flux_Paper_Plan.md C1). Threads live in a sibling
// `manuscript/comments.json` — never in the .qmd (Principle 6). Anchors use a
// W3C-style TextQuoteSelector so comments re-anchor after out-of-app edits: exact
// offset first, else a fuzzy search (approx-string-match, the primitive
// Hypothesis uses) disambiguated by prefix/suffix + proximity, else detached.

import search from "approx-string-match";
import { fileBridge, joinPath, type LoadedProject } from "../../../../lib/project/types";

export interface CommentMessage {
  author: string;
  body: string;
  createdAt: string;
}
export interface TextQuoteSelector {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}
export interface CommentThread {
  id: string;
  anchor: TextQuoteSelector;
  resolved: boolean;
  messages: CommentMessage[];
}
interface CommentsFile {
  version: 1;
  threads: CommentThread[];
}

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
function commentsPath(p: LoadedProject): string {
  const mp = p.manifest.manuscript.path; // e.g. "manuscript/main.qmd"
  const dir = mp.includes("/") ? mp.slice(0, mp.lastIndexOf("/")) : "";
  return joinPath(p.root, dir, "comments.json");
}

export async function readComments(p: LoadedProject): Promise<CommentThread[]> {
  const fb = fileBridge();
  if (!fb) return [];
  const path = commentsPath(p);
  try {
    if (!(await fb.exists(path))) return [];
    const data = JSON.parse(await fb.readText(path)) as CommentsFile;
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

export async function writeComments(p: LoadedProject, threads: CommentThread[]): Promise<void> {
  const fb = fileBridge();
  if (!fb) return;
  const file: CommentsFile = { version: 1, threads };
  await fb.writeText(commentsPath(p), JSON.stringify(file, null, 2) + "\n");
}

export function newId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
