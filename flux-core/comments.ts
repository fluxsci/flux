// flux-core/comments.ts — review-comment threads over Node fs (split out of
// index.ts; WS-6.2).

import * as fs from "node:fs/promises";
import { appendCommentMessage, mergeCommentThreads, type CommentMessage, type CommentThread, type CommentsFile } from "../src/lib/project/comments";
export type { CommentMessage, CommentThread, TextQuoteSelector, CommentsFile } from "../src/lib/project/comments";
import type { SessionRef } from "../src/lib/project/annotations";
import { CLIENT, stamp, journal } from "./journal";
import { withLock } from "./locks";
import { loadManifest, safeJoin, exists, writeText } from "./model";
import { listDocuments } from "./manuscript";
import type { ProjectManifest } from "../src/lib/project/types";
import { commentsSidecarRel, commentsSidecarRels, commentsMainPath } from "../src/lib/project/docOrder";

// --------------------------------------------------------------------------
// Review comments (the human's margin comments). Threads live in a sibling
// `comments.json` (main doc) / `<base>.comments.json` (other docs) — never in
// the .qmd (Principle 6). The shared project/comments.ts owns message append
// policy; Node IO owns locks and journaling for the same sidecars the GUI writes. The anchor is a W3C-style TextQuoteSelector: `quote` (+ prefix/suffix)
// is the exact manuscript text a comment targets.
// --------------------------------------------------------------------------
export interface DocumentCommentThread extends CommentThread {
  /** Project-relative document path whose sidecar owns this thread. */
  doc: string;
}
/** The comments sidecar path (project-relative) for a document. The main
 *  manuscript keeps `comments.json`; other docs get `<base>.comments.json`. */
function commentsRel(m: ProjectManifest, docRel?: string): string {
  // One derivation for both engines (docOrder.ts) — deleting a document
  // removes exactly the sidecar this wrote.
  return commentsSidecarRel(commentsMainPath(m), docRel ?? m.manuscript.path);
}

async function readCommentsFile(root: string, rel: string): Promise<CommentsFile | null> {
  const p = safeJoin(root, rel);
  if (!(await exists(p))) return null;
  try {
    const data = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
    return { ...data, version: 1, threads: Array.isArray(data.threads) ? data.threads : [] };
  } catch {
    return null;
  }
}

/** list-comments: read a document's comment threads (defaults to the main .qmd).
 *  Returns all threads; the caller filters resolved vs. open. Empty if none. */
export async function listComments(root: string, docRel?: string): Promise<CommentThread[]> {
  const m = await loadManifest(root);
  const files: CommentsFile[] = [];
  for (const rel of commentsSidecarRels(m, docRel)) {
    const file = await readCommentsFile(root, rel);
    if (file) files.push(file);
  }
  return mergeCommentThreads(files);
}

/** Project-wide review discovery. With no docRel, scan every canonical project
 *  document (including Context documents) and attach the owning document path
 *  to every thread. Passing docRel keeps the same enriched shape while targeting
 *  one document. */
export async function listProjectComments(
  root: string,
  docRel?: string,
): Promise<DocumentCommentThread[]> {
  const docs = docRel ? [docRel] : (await listDocuments(root)).map((doc) => doc.path);
  const out: DocumentCommentThread[] = [];
  for (const doc of docs) {
    for (const thread of await listComments(root, doc)) out.push({ ...thread, doc });
  }
  return out;
}

/** Context kept around the quote for re-anchoring (mirrors the GUI's CTX). */
const CTX = 32;

export interface AddCommentResult {
  id: string;
  quote: string;
  doc: string;
  total: number;
}

/** add-comment: open a NEW thread anchored to exact document text — the agent's
 *  channel for asking the human questions in the margin. `quote` must occur in
 *  the document; when it occurs more than once, `at` picks the 1-based
 *  occurrence (error otherwise, listing the count). Holds the `manuscript`
 *  lock + journals; the open app live-refreshes the margin. */
export async function addComment(
  root: string,
  opts: { quote: string; body: string; docRel?: string; at?: number; author?: string; client?: string; session?: SessionRef },
): Promise<AddCommentResult> {
  const quote = opts.quote ?? "";
  const body = (opts.body ?? "").trim();
  if (!quote) throw new Error("add-comment needs --quote (the exact text to anchor to)");
  if (!body) throw new Error("add-comment needs --body (the message)");
  const m = await loadManifest(root);
  const docRel = opts.docRel ?? m.manuscript.path;
  const docPath = safeJoin(root, docRel);
  if (!(await exists(docPath))) throw new Error(`no such document: ${docRel}`);
  const text = await fs.readFile(docPath, "utf8");
  const starts: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) starts.push(i);
  if (starts.length === 0) throw new Error(`quote not found in ${docRel}: "${quote}"`);
  let start: number;
  if (starts.length === 1) start = starts[0];
  else if (opts.at && opts.at >= 1 && opts.at <= starts.length) start = starts[opts.at - 1];
  else
    throw new Error(
      `quote occurs ${starts.length}× in ${docRel} — pass --at <1..${starts.length}> to pick one`,
    );
  const end = start + quote.length;
  const thread: CommentThread = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    anchor: {
      start,
      end,
      quote,
      prefix: text.slice(Math.max(0, start - CTX), start),
      suffix: text.slice(end, end + CTX),
    },
    resolved: false,
    messages: [{ author: opts.author ?? CLIENT, body, createdAt: stamp(), ...(opts.session ? { kind: "agent", client: opts.client, session: opts.session } : {}) }],
  };
  const rel = commentsRel(m, opts.docRel);
  const p = safeJoin(root, rel);
  return withLock(root, "manuscript", opts.client ?? CLIENT, async () => {
    let file: CommentsFile = { version: 1, threads: [] };
    if (await exists(p)) {
      try {
        const cur = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
        if (Array.isArray(cur.threads)) file = { ...cur, version: 1, threads: cur.threads };
      } catch {
        throw new Error(`comments file is not valid JSON: ${rel}`);
      }
    }
    file.threads.push(thread);
    await writeText(p, JSON.stringify(file, null, 2) + "\n");
    await journal(root, { action: "add_comment", target: rel, thread: thread.id, client: opts.client ?? CLIENT, session: opts.session });
    return { id: thread.id, quote, doc: docRel, total: file.threads.length };
  });
}

export interface CommentWriteOptions {
  docRel?: string; note?: string; author?: string; client?: string; session?: SessionRef;
  beforeWrite?: () => Promise<void>;
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
  opts: CommentWriteOptions = {},
): Promise<ResolveCommentResult> {
  return withLock(root, "manuscript", opts.client ?? CLIENT, async () => {
    const m = await loadManifest(root);
    const files: Array<{ rel: string; file: CommentsFile }> = [];
    for (const rel of commentsSidecarRels(m, opts.docRel)) {
      const p = safeJoin(root, rel);
      if (!(await exists(p))) continue;
      let file: CommentsFile;
      try {
        file = JSON.parse(await fs.readFile(p, "utf8")) as CommentsFile;
      } catch {
        throw new Error(`comments file is not valid JSON: ${rel}`);
      }
      files.push({ rel, file: { ...file, version: 1, threads: Array.isArray(file.threads) ? file.threads : [] } });
    }
    if (files.length === 0) throw new Error(`no comments file: ${commentsRel(m, opts.docRel)}`);

    let hit = files
      .flatMap(({ rel, file }) => file.threads.map((thread) => ({ rel, file, thread })))
      .find(({ thread }) => thread.id === idOrQuote);
    if (!hit) {
      const needle = idOrQuote.toLowerCase();
      const hits = files.flatMap(({ rel, file }) =>
        file.threads
          .filter((thread) => (thread.anchor?.quote ?? "").toLowerCase().includes(needle))
          .map((thread) => ({ rel, file, thread })),
      );
      if (hits.length === 0)
        throw new Error(
          `no comment matches "${idOrQuote}" in ${files.map(({ rel }) => rel).join(", ")}`,
        );
      if (hits.length > 1)
        throw new Error(
          `"${idOrQuote}" matches ${hits.length} comments; use the thread id (one of: ${hits.map(({ thread }) => thread.id).join(", ")})`,
        );
      hit = hits[0];
    }
    if (!hit) throw new Error(`no comment matches "${idOrQuote}"`);
    const { rel, file, thread } = hit;
    if (thread.resolved) throw new Error(`comment ${thread.id} is already resolved`);
    await opts.beforeWrite?.();
    thread.resolved = true;
    if (opts.note) {
      thread.messages = thread.messages ?? [];
      thread.messages.push({ author: opts.author ?? CLIENT, body: opts.note, createdAt: stamp(), kind: "agent", client: opts.client, session: opts.session });
    }
    const p = safeJoin(root, rel);
    const out: CommentsFile = { version: 1, threads: file.threads };
    await writeText(p, JSON.stringify(out, null, 2) + "\n");
    await journal(root, { action: "resolve_comment", target: rel, thread: thread.id, client: opts.client ?? CLIENT, session: opts.session });
    const merged = new Map<string, CommentThread>();
    for (const source of files) {
      for (const candidate of source.file.threads) {
        if (!merged.has(candidate.id)) merged.set(candidate.id, candidate);
      }
    }
    return {
      id: thread.id,
      quote: thread.anchor?.quote ?? "",
      resolved: [...merged.values()].filter((candidate) => candidate.resolved).length,
      total: merged.size,
    };
  });
}

/** Resolve a unique open comment across the whole project by default. Passing
 *  docRel preserves the targeted single-document behavior. */
export async function resolveProjectComment(
  root: string,
  idOrQuote: string,
  opts: CommentWriteOptions = {},
): Promise<ResolveCommentResult> {
  if (opts.docRel) return resolveComment(root, idOrQuote, opts);
  const open = (await listProjectComments(root)).filter((thread) => !thread.resolved);
  let hits = open.filter((thread) => thread.id === idOrQuote);
  if (hits.length === 0) {
    const needle = idOrQuote.toLowerCase();
    hits = open.filter((thread) => (thread.anchor?.quote ?? "").toLowerCase().includes(needle));
  }
  if (hits.length === 0) throw new Error(`no open comment matches "${idOrQuote}" in project documents`);
  if (hits.length > 1) {
    throw new Error(
      `"${idOrQuote}" matches ${hits.length} open comments across project documents; ` +
        `pass --doc or use one of: ${hits.map((thread) => `${thread.doc}:${thread.id}`).join(", ")}`,
    );
  }
  const hit = hits[0];
  return resolveComment(root, hit.id, { ...opts, docRel: hit.doc });
}

/** Append to the owning sidecar under its manuscript operation lease. */
export async function replyToComment(root: string, id: string, body: string, opts: CommentWriteOptions = {}) {
  return withLock(root, "manuscript", opts.client ?? CLIENT, async () => {
    const threads = await listProjectComments(root, opts.docRel);
    const hits = threads.filter(t => t.id === id);
    if (hits.length !== 1) throw new Error(`expected one comment ${id}, found ${hits.length}`);
    const hit = hits[0], manifest = await loadManifest(root);
    for (const rel of commentsSidecarRels(manifest, hit.doc)) {
      const file = await readCommentsFile(root, rel);
      if (!file?.threads.some(t => t.id === id)) continue;
      const message: CommentMessage = { author: opts.author ?? CLIENT, body, createdAt: stamp(), kind: "agent", client: opts.client, session: opts.session };
      const next = appendCommentMessage(file, id, message);
      await opts.beforeWrite?.();
      await writeText(safeJoin(root, rel), JSON.stringify(next, null, 2) + "\n");
      await journal(root, { action: "reply_comment", target: rel, thread: id, client: opts.client ?? CLIENT, session: opts.session });
      return { id, doc: hit.doc, message };
    }
    throw new Error(`comment ${id} disappeared before reply`);
  });
}
