// Pure sidecar operations, shared by the Paper margin and the headless inbox.
export interface CommentMessage {
  author: string;
  body: string;
  createdAt: string;
  kind?: "agent" | "human";
  /** Set when a person rewrote the message after sending it. */
  editedAt?: string;
  client?: string;
  session?: { id: string; name: string; client?: string };
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
  /** Tags you attached to it (lower-case names, no "#"). Tags typed as #words in a message
   *  still count; these are the ones chosen from your list. */
  tags?: string[];
  /** Whether the comment is in the AI Inbox. `false` = a note to yourself: agents are not shown
   *  it. `true` = sent to the Inbox. Absent = written before the choice existed, or by an
   *  agent: in the Inbox, as it always was. */
  inbox?: boolean;
}
export interface CommentsFile { version: 1; threads: CommentThread[] }

/** Return a new sidecar; preserve unknown fields and every unrelated thread. */
export function appendCommentMessage<T extends CommentsFile>(sidecar: T, id: string, msg: CommentMessage): T {
  const thread = sidecar.threads.find(t => t.id === id);
  if (!thread) throw new Error(`no comment matches "${id}"`);
  if (thread.resolved) throw new Error(`comment ${id} is already resolved`);
  if (!msg.body.trim()) throw new Error("a comment reply needs text");
  return { ...sidecar, threads: sidecar.threads.map(t => t === thread ? { ...t, messages: [...t.messages, { ...msg }] } : t) };
}

/** Reopening changes only this thread; archive/claims remain ledger overlays. */
export function reopenCommentThread<T extends CommentsFile>(sidecar: T, id: string): T {
  if (!sidecar.threads.some(t => t.id === id)) throw new Error(`no comment matches "${id}"`);
  return { ...sidecar, threads: sidecar.threads.map(t => t.id === id ? { ...t, resolved: false } : t) };
}

export function mergeCommentThreads(files: readonly CommentsFile[]): CommentThread[] {
  const seen = new Set<string>();
  return files.flatMap(file => file.threads.filter(t => {
    if (seen.has(t.id)) return false;
    seen.add(t.id); return true;
  }));
}

/** Is this thread in the AI Inbox (and so shown to agents)? Only an explicit `false` keeps it out. */
export const commentInInbox = (thread: { inbox?: boolean }): boolean => thread.inbox !== false;

/** A tag's stored form: lower case, no leading "#", letters digits "_" "-" (the same shape a
 *  typed #tag has), at most 32 characters. "" when nothing usable is left. */
export function normalizeTag(raw: string): string {
  const name = raw.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "");
  return name.slice(0, 32);
}

const mapThread = <T extends CommentsFile>(sidecar: T, id: string, change: (thread: CommentThread) => CommentThread): T => {
  if (!sidecar.threads.some(t => t.id === id)) throw new Error(`no comment matches "${id}"`);
  return { ...sidecar, threads: sidecar.threads.map(t => t.id === id ? change(t) : t) };
};

/** Replace a thread's tags (normalized, de-duplicated, in the order given). No tags = no field. */
export function setCommentTags<T extends CommentsFile>(sidecar: T, id: string, tags: readonly string[]): T {
  const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  return mapThread(sidecar, id, ({ tags: _old, ...thread }) => clean.length ? { ...thread, tags: clean } : thread);
}

/** Put a thread in the AI Inbox, or keep it to yourself. */
export function setCommentInbox<T extends CommentsFile>(sidecar: T, id: string, inbox: boolean): T {
  return mapThread(sidecar, id, thread => ({ ...thread, inbox }));
}

/** Rewrite one message's text. Only what a person wrote can be edited (an agent's words stay
 *  as it said them); the message keeps its author and time and gains `editedAt`. */
export function editCommentMessage<T extends CommentsFile>(sidecar: T, id: string, index: number, body: string, at = new Date().toISOString()): T {
  if (!body.trim()) throw new Error("a comment needs text");
  return mapThread(sidecar, id, thread => {
    const message = thread.messages[index];
    if (!message) throw new Error(`comment ${id} has no message ${index + 1}`);
    if (message.kind === "agent") throw new Error("an agent's reply cannot be edited");
    return { ...thread, messages: thread.messages.map((m, i) => i === index ? { ...m, body, editedAt: at } : m) };
  });
}

// ---- Merging a live editor's threads with the sidecar on disk -----------------------------
// The open Paper editor keeps its threads in memory and saves them on a debounce. Anything an
// agent wrote to the sidecar meanwhile (a reply, a resolve, a new thread) must survive that
// save: before 2026-11-19 the save replaced the file with the in-memory list and erased every
// agent reply it had not seen. This is a three-way merge against `base`, the sidecar as the
// editor last read or wrote it: a side that changed something since `base` keeps its change.

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** A message's identity. Messages are append-only and carry no id; an edit keeps its author
 *  and time (it only changes the body and adds `editedAt`). */
const messageKey = (m: CommentMessage) => `${m.createdAt}\u0000${m.author}`;

function rebaseMessages(base: readonly CommentMessage[], mine: readonly CommentMessage[], theirs: readonly CommentMessage[]): CommentMessage[] {
  const baseBy = new Map(base.map(m => [messageKey(m), m]));
  const theirsBy = new Map(theirs.map(m => [messageKey(m), m]));
  const mineKeys = new Set(mine.map(messageKey));
  // Never drop a message: Paper has no message deletion, so one missing from a side is one
  // that side has not seen yet. A message both sides hold takes the side that edited it.
  const kept = mine.map(m => {
    const key = messageKey(m), b = baseBy.get(key), t = theirsBy.get(key);
    return t && b && same(m, b) && !same(t, b) ? t : m;
  });
  const added = theirs.filter(m => !mineKeys.has(messageKey(m)));
  if (!added.length) return kept;
  // Chronological, stable: an agent's reply lands between the messages it was written among.
  return [...kept, ...added].map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.createdAt < b.m.createdAt ? -1 : a.m.createdAt > b.m.createdAt ? 1 : a.i - b.i))
    .map(({ m }) => m);
}

function rebaseThread<T extends CommentThread>(base: CommentThread | undefined, mine: T, theirs: CommentThread): T {
  const out = { ...mine } as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const key of keys) {
    if (key === "id" || key === "messages") continue;
    const m = (mine as unknown as Record<string, unknown>)[key], b = (base as unknown as Record<string, unknown> | undefined)?.[key];
    // The editor changed this field (or there is no base to tell): its value stands. Otherwise
    // the disk's does, including a field the disk removed.
    if (!base || !same(m, b)) continue;
    const t = (theirs as unknown as Record<string, unknown>)[key];
    if (t === undefined) delete out[key]; else out[key] = t;
  }
  out.messages = rebaseMessages(base?.messages ?? [], mine.messages, theirs.messages);
  return out as unknown as T;
}

/**
 * Merge an editor's in-memory threads (`mine`) with the sidecar's current threads (`theirs`),
 * given `base`, the threads the editor last read from or wrote to disk (null when unknown,
 * which merges as a union and drops nothing).
 *
 * - A thread on both sides merges field by field (the side that changed a field since `base`
 *   wins; the editor wins a true conflict) and keeps every message from both.
 * - A thread only the disk has is kept, unless the editor deleted it since `base` and the disk
 *   has added nothing to it since (a delete never silently swallows an unseen reply).
 * - A thread only the editor has is kept, unless the disk deleted it since `base` and the
 *   editor has not changed it since.
 *
 * Order: the editor's threads in its order, then the disk's new ones in theirs. Threads that
 * come through unchanged keep their object identity, so a caller can tell nothing moved.
 */
export function rebaseCommentThreads<T extends CommentThread>(
  base: readonly CommentThread[] | null,
  mine: readonly T[],
  theirs: readonly CommentThread[],
): (T | CommentThread)[] {
  const baseBy = new Map((base ?? []).map(t => [t.id, t]));
  const theirsBy = new Map(theirs.map(t => [t.id, t]));
  const mineIds = new Set(mine.map(t => t.id));
  const out: (T | CommentThread)[] = [];
  for (const m of mine) {
    const t = theirsBy.get(m.id), b = baseBy.get(m.id);
    if (!t) {
      if (b && same(m, b)) continue; // deleted on disk, untouched here
      out.push(m);
    } else out.push(same(m, t) ? m : rebaseThread(b, m, t));
  }
  for (const t of theirs) {
    if (mineIds.has(t.id)) continue;
    const b = baseBy.get(t.id);
    if (b) {
      const baseKeys = new Set(b.messages.map(messageKey));
      if (!t.messages.some(msg => !baseKeys.has(messageKey(msg)))) continue; // deleted here
    }
    out.push(t);
  }
  return out;
}
