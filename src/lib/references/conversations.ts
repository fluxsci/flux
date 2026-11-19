// Conversations about a paper, kept WITH the paper: items/<citekey>/conversations.json in the
// user-level FluxLib, beside the highlights (annotations.json). A question asked of Flux AI while
// reading belongs to the passage it was asked about, not to the project that happened to be open:
// the same paper opened from any project shows the same conversations.
//
// Two kinds of thread, each with ONE home:
//   - "item": a copy of a project's Inbox item made while reading (Annotate). The project's ledger
//     stays where agents claim and answer it; every change there is mirrored here by item id.
//   - "ask": an Ask exchange. It has no ledger entry, so this file is the only place it lives.
// A thread hangs on a highlight (highlightId) when it was asked about selected text, and on the
// page otherwise (a region drawn on a figure, a question about the page). Several threads may hang
// on one highlight.
//
// Pure: no I/O and no DOM (the renderer bridge and flux-core both load it). Unknown fields are
// kept on a rewrite, as in annotations.ts.
import type { Annotation } from "./annotations";
import type { ItemStatus } from "../project/annotations";
import type { InboxItem } from "../project/inbox";

export interface PaperMessage {
  kind: "human" | "agent";
  author: string;
  text: string;
  ts: string;
}

export interface PaperOrigin {
  kind: "item" | "ask";
  /** The project it was asked in: shown as "from <title>"; `id` says whether that is the open one. */
  project?: { id?: string; title: string };
  /** That project's folder on the machine that wrote the thread. */
  root?: string;
}

export interface PaperThread {
  /** An item thread carries its Inbox item's id. */
  id: string;
  origin: PaperOrigin;
  page?: number;
  /** The words it was asked about. `prefix`/`suffix` are present only for a real text selection. */
  anchor?: { quote: string; prefix?: string; suffix?: string };
  highlightId?: string;
  /** Set when it was asked on a supplement (highlights anchor to the main text only). */
  source?: { supplement: string };
  status: ItemStatus;
  /** The agent holding it now, when one is. */
  agent?: string;
  createdAt: string;
  updatedAt: string;
  messages: PaperMessage[];
}

export interface ConversationFile {
  version: 1;
  threads: PaperThread[];
  /** Threads the reader removed from this paper (id → when): a mirror never brings them back. */
  removed?: Record<string, string>;
}

export const emptyConversationFile = (): ConversationFile => ({ version: 1, threads: [] });

const isText = (v: unknown): v is string => typeof v === "string";

/** Validate canonical storage without rebuilding or dropping unknown fields. */
export function validateConversations(raw: unknown): ConversationFile {
  const f = raw as ConversationFile;
  if (!f || typeof f !== "object" || f.version !== 1 || !Array.isArray(f.threads)) throw new Error("Expected version 1 conversations");
  if (f.removed !== undefined && (!f.removed || typeof f.removed !== "object" || Array.isArray(f.removed) || Object.values(f.removed).some(v => !isText(v)))) throw new Error("Invalid removed list");
  const ids = new Set<string>();
  for (const t of f.threads) {
    if (!t || !isText(t.id) || !t.id || ids.has(t.id) || !t.origin || (t.origin.kind !== "item" && t.origin.kind !== "ask") ||
        !isText(t.status) || !isText(t.createdAt) || !isText(t.updatedAt) || !Array.isArray(t.messages) ||
        (t.page !== undefined && (!Number.isInteger(t.page) || t.page < 1)) ||
        (t.anchor !== undefined && (!t.anchor || !isText(t.anchor.quote))) ||
        (t.highlightId !== undefined && !isText(t.highlightId)) ||
        t.messages.some(m => !m || (m.kind !== "human" && m.kind !== "agent") || !isText(m.author) || !isText(m.text) || !isText(m.ts))) throw new Error("Invalid conversation record");
    ids.add(t.id);
  }
  return f;
}

// ---------------------------------------------------------------------------
// What an Inbox item says about a paper
// ---------------------------------------------------------------------------

export interface PaperRef {
  citekey: string;
  page?: number;
  anchor?: PaperThread["anchor"];
  highlightId?: string;
  source?: { supplement: string };
}

/**
 * The paper an Inbox item was made on while READING it, or null. A passage target (the selection's
 * menu, a highlight's popover, a mark drawn on a page) or a reader stamp qualifies; a Library row
 * does not (that is a task about the reference, not a conversation about its text).
 */
export function paperRef(item: Pick<InboxItem, "kind" | "targets" | "context">): PaperRef | null {
  if (item.kind !== "annotation") return null;
  const reader = item.context?.reader ?? null;
  const target = item.targets.find(t => t.kind === "passage");
  const source = reader?.source && reader.source !== "main" ? { source: { supplement: reader.source.supplement } } : {};
  if (target?.kind === "passage") {
    const quote = target.quote?.trim();
    return { citekey: target.citekey, page: target.page, ...source,
      ...(quote ? { anchor: { quote, ...(target.prefix !== undefined ? { prefix: target.prefix } : {}), ...(target.suffix !== undefined ? { suffix: target.suffix } : {}) } } : {}),
      ...(target.highlightId ? { highlightId: target.highlightId } : {}) };
  }
  if (!reader?.citekey) return null;
  const quote = reader.selection?.trim();
  return { citekey: reader.citekey, ...(reader.page ? { page: reader.page } : {}), ...source,
    ...(quote ? { anchor: { quote } } : {}), ...(reader.highlightId ? { highlightId: reader.highlightId } : {}) };
}

const message = (m: { kind: string; author: string; text: string; ts: string }): PaperMessage =>
  ({ kind: m.kind === "agent" ? "agent" : "human", author: m.author, text: m.text, ts: m.ts });

/** The paper's copy of an Inbox item (null when the item is not about a paper being read). */
export function threadFromItem(item: InboxItem, origin: Omit<PaperOrigin, "kind">): { citekey: string; thread: PaperThread } | null {
  const ref = paperRef(item);
  if (!ref) return null;
  const { citekey, ...where } = ref;
  return { citekey, thread: {
    id: item.id,
    origin: { kind: "item", ...origin },
    ...where,
    status: item.status,
    ...(item.claimedBy?.live ? { agent: item.claimedBy.name } : {}),
    createdAt: item.createdAt,
    updatedAt: item.lastActivity || item.createdAt,
    messages: item.thread.map(message),
  } };
}

/**
 * An Ask exchange as a thread of its own (null until there is an answer worth keeping).
 * `times[i]` is when message i was said; a message past its end takes the last one.
 */
export function threadFromAsk(id: string, ref: PaperRef, origin: Omit<PaperOrigin, "kind">,
  messages: readonly { role: "human" | "agent"; text: string }[], agent: string, times: readonly string[]): PaperThread | null {
  const said = messages.filter(m => m.text.trim());
  if (said[0]?.role !== "human" || !said.some(m => m.role === "agent") || !times.length) return null;
  const { citekey: _citekey, ...where } = ref;
  const at = (i: number) => times[Math.min(i, times.length - 1)];
  return {
    id, origin: { kind: "ask", ...origin }, ...where, status: "resolved", createdAt: at(0), updatedAt: at(said.length - 1),
    messages: said.map((m, i) => ({ kind: m.role, author: m.role === "human" ? "You" : agent, text: m.text.trim(), ts: at(i) })),
  };
}

// ---------------------------------------------------------------------------
// The file as a set of threads
// ---------------------------------------------------------------------------

/** What a mirror compares: what a reader would see change. Not the highlight link (the paper owns
 *  that), and not `updatedAt` alone (a holder's heartbeat must not rewrite the file). */
export function threadSignature(t: PaperThread): string {
  return JSON.stringify([t.status, t.agent ?? "", t.page ?? 0, t.anchor?.quote ?? "", t.origin.project?.title ?? "",
    t.messages.map(m => [m.kind, m.author, m.text, m.ts])]);
}

/**
 * Write `thread` into the file. An existing thread keeps its unknown fields and its highlight
 * link (the reader may have linked it since); a removed id stays removed; a withdrawn item leaves.
 * Returns whether the file changed, and whether the thread is new to it.
 */
export function upsertThread(file: ConversationFile, thread: PaperThread): { changed: boolean; added: boolean } {
  if (file.removed?.[thread.id]) return { changed: false, added: false };
  const at = file.threads.findIndex(t => t.id === thread.id);
  if (thread.status === "withdrawn") {
    if (at < 0) return { changed: false, added: false };
    file.threads.splice(at, 1);
    return { changed: true, added: false };
  }
  if (at < 0) { file.threads.push(thread); return { changed: true, added: true }; }
  const old = file.threads[at];
  const next: PaperThread = { ...old, ...thread, ...(thread.highlightId ?? old.highlightId ? { highlightId: thread.highlightId ?? old.highlightId } : {}),
    // An exact anchor already on file is never traded for a bare quote.
    ...(old.anchor && thread.anchor && old.anchor.quote === thread.anchor.quote ? { anchor: { ...old.anchor, ...thread.anchor } } : {}) };
  if (!thread.agent) delete next.agent;
  if (JSON.stringify(next) === JSON.stringify(old)) return { changed: false, added: false };
  file.threads[at] = next;
  return { changed: true, added: false };
}

/** Take a thread off the paper. `forget` also records it, so a later mirror cannot restore it. */
export function removeThread(file: ConversationFile, id: string, forget: boolean, now = new Date().toISOString()): boolean {
  const at = file.threads.findIndex(t => t.id === id);
  if (at < 0 && !(forget && !file.removed?.[id])) return false;
  if (at >= 0) file.threads.splice(at, 1);
  if (forget) file.removed = { ...(file.removed ?? {}), [id]: now };
  return true;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The highlight a thread hangs on: its own link when that still exists, else one on the same words. */
export function highlightFor(thread: Pick<PaperThread, "highlightId" | "page" | "anchor" | "source">, annotations: readonly Annotation[]): Annotation | null {
  if (thread.source) return null;
  const linked = thread.highlightId ? annotations.find(a => a.id === thread.highlightId) : undefined;
  if (linked) return linked;
  // A link whose highlight was deleted stays loose: deleting a highlight must not move its
  // conversation onto a neighbour.
  if (thread.highlightId || !thread.anchor || !thread.page) return null;
  const quote = squash(thread.anchor.quote);
  return annotations.find(a => a.page === thread.page && squash(a.anchor.quote) === quote) ?? null;
}

/** True when a new thread should get a highlight of its own: real selected text, on the main PDF. */
export function wantsHighlight(thread: PaperThread): thread is PaperThread & { page: number; anchor: { quote: string; prefix: string; suffix: string } } {
  return !thread.source && !thread.highlightId && !!thread.page && !!thread.anchor?.quote.trim() &&
    typeof thread.anchor.prefix === "string" && typeof thread.anchor.suffix === "string";
}

export interface ThreadGroups {
  /** Threads by the id of the highlight each hangs on, oldest first. */
  byHighlight: Map<string, PaperThread[]>;
  /** Threads on a page (or the paper) with no highlight under them. */
  loose: PaperThread[];
}

export function groupThreads(threads: readonly PaperThread[], annotations: readonly Annotation[]): ThreadGroups {
  const byHighlight = new Map<string, PaperThread[]>(), loose: PaperThread[] = [];
  for (const t of [...threads].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const h = highlightFor(t, annotations);
    if (!h) { loose.push(t); continue; }
    const list = byHighlight.get(h.id);
    if (list) list.push(t); else byHighlight.set(h.id, [t]);
  }
  return { byHighlight, loose };
}

/** The question a thread opened with, on one line. */
export function threadQuestion(t: Pick<PaperThread, "messages">): string {
  return squash(t.messages.find(m => m.kind === "human")?.text ?? t.messages[0]?.text ?? "");
}

/** What a row says about a thread's state, or "" when it is simply answered. */
export function threadState(t: Pick<PaperThread, "status" | "agent" | "messages">): string {
  if (t.status === "needs-input") return `${t.agent ?? "An agent"} asks you`;
  if (t.status === "claimed") return `${t.agent ?? "An agent"} is working`;
  if (t.status === "open" || t.status === "queued") return t.messages.some(m => m.kind === "agent") ? "Open" : "Waiting for an agent";
  return "";
}

/** Earlier exchanges on the same words, for an agent asked about them again (bounded). */
export function earlierThreads(threads: readonly PaperThread[], about: Pick<PaperThread, "highlightId" | "page" | "anchor">, except?: string, max = 4) {
  const quote = about.anchor ? squash(about.anchor.quote) : "";
  const clip = (s: string) => (s.length > 1500 ? s.slice(0, 1499) + "…" : s);
  return threads.filter(t => t.id !== except && t.messages.some(m => m.kind === "agent") && (
    (about.highlightId && t.highlightId === about.highlightId) || (!!quote && t.page === about.page && !!t.anchor && squash(t.anchor.quote) === quote)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-max)
    .map(t => ({ id: t.id, from: t.origin.project?.title ?? null, asked: t.createdAt, status: t.status,
      messages: t.messages.slice(-8).map(m => ({ author: m.author, text: clip(m.text) })) }));
}
