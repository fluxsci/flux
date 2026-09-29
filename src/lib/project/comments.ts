// Pure sidecar operations, shared by the Paper margin and the headless inbox.
export interface CommentMessage {
  author: string;
  body: string;
  createdAt: string;
  kind?: "agent" | "human";
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
