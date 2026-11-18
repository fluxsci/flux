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
