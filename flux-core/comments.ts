// flux-core/comments.ts — review-comment threads over Node fs (split out of
// index.ts; WS-6.2).

import * as fs from "node:fs/promises";
import { CLIENT, stamp, journal } from "./journal";
import { withLock } from "./locks";
import { loadManifest, safeJoin, exists, writeText } from "./model";
import type { ProjectManifest } from "../src/lib/project/types";

// --------------------------------------------------------------------------
// Review comments (the human's margin comments). Threads live in a sibling
// `comments.json` (main doc) / `<base>.comments.json` (other docs) — never in
// the .qmd (Principle 6). Mirrors src/shell/modes/paper/comments/comments.ts so
// an agent has first-class, journaled, lock-respecting access to the same file
// the GUI writes (the GUI editor is the authoring side; this is the read/resolve
// side). The anchor is a W3C-style TextQuoteSelector: `quote` (+ prefix/suffix)
// is the exact manuscript text a comment targets.
// --------------------------------------------------------------------------
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

/** The comments sidecar path (project-relative) for a document. The main
 *  manuscript keeps `comments.json`; other docs get `<base>.comments.json`. */
function commentsRel(m: ProjectManifest, docRel?: string): string {
  const mp = docRel ?? m.manuscript.path; // e.g. "manuscript/main.qmd"
  const dir = mp.includes("/") ? mp.slice(0, mp.lastIndexOf("/")) : "";
  const isMain = mp === m.manuscript.path;
  const base = mp.slice(mp.lastIndexOf("/") + 1).replace(/\.(qmd|md)$/, "");
  const name = isMain ? "comments.json" : `${base}.comments.json`;
  return dir ? `${dir}/${name}` : name;
}

/** list-comments: read a document's comment threads (defaults to the main .qmd).
 *  Returns all threads; the caller filters resolved vs. open. Empty if none. */
export async function listComments(root: string, docRel?: string): Promise<CommentThread[]> {
  const m = await loadManifest(root);
  const p = safeJoin(root, commentsRel(m, docRel));
  if (!(await exists(p))) return [];
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

export interface ResolveCommentResult {
  id: string;
  quote: string;
  resolved: number;
  total: number;
}

/** resolve-comment: mark a thread resolved — by its id, or by a substring of its
 *  quoted text (must match exactly one open thread). Optionally append a reply.
 *  Holds the `manuscript` lock (so it defers to a live human edit) + journals. */
export async function resolveComment(
  root: string,
  idOrQuote: string,
  opts: { docRel?: string; note?: string; author?: string } = {},
): Promise<ResolveCommentResult> {
  const m = await loadManifest(root);
  const rel = commentsRel(m, opts.docRel);
  const p = safeJoin(root, rel);
  if (!(await exists(p))) throw new Error(`no comments file: ${rel}`);
  let file: CommentsFile;
  try {
    file = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
  } catch {
    throw new Error(`comments file is not valid JSON: ${rel}`);
  }
  const threads = Array.isArray(file.threads) ? file.threads : [];
  let thread = threads.find((t) => t.id === idOrQuote);
  if (!thread) {
    const needle = idOrQuote.toLowerCase();
    const hits = threads.filter((t) => (t.anchor?.quote ?? "").toLowerCase().includes(needle));
    if (hits.length === 0) throw new Error(`no comment matches "${idOrQuote}" in ${rel}`);
    if (hits.length > 1)
      throw new Error(
        `"${idOrQuote}" matches ${hits.length} comments; use the thread id (one of: ${hits.map((t) => t.id).join(", ")})`,
      );
    thread = hits[0];
  }
  thread.resolved = true;
  if (opts.note) {
    thread.messages = thread.messages ?? [];
    thread.messages.push({ author: opts.author ?? CLIENT, body: opts.note, createdAt: stamp() });
  }
  const out: CommentsFile = { version: 1, threads };
  await withLock(root, "manuscript", CLIENT, async () => {
    await writeText(p, JSON.stringify(out, null, 2) + "\n");
  });
  await journal(root, { action: "resolve_comment", target: rel, thread: thread.id });
  return {
    id: thread.id,
    quote: thread.anchor?.quote ?? "",
    resolved: threads.filter((t) => t.resolved).length,
    total: threads.length,
  };
}
