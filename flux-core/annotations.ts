// Headless annotation IO. All review policy lives in the pure shared cores.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ANNOTATIONS_REL, claimIsLive, foldAnnotations, parseLedger, serializeEvent, writeAllowed,
  makeClaim, makeRelease, makeReply, makeResolve, makeState, makeArchive,
  type AnnotationEvent, type ItemOverlay, type SessionRef,
} from "../src/lib/project/annotations";
import {
  buildInbox, filterInbox, resolveInboxFilter, parseInboxQuery, type InboxFilter, type InboxItem,
} from "../src/lib/project/inbox";
import { liveSessions, parsePresence, PRESENCE_DIR_REL } from "../src/lib/project/presence";
import { detectAgentIdentity, type AgentIdentity } from "./agentIdentity";
import { listProjectComments, replyToComment, resolveProjectComment } from "./comments";
import { listDocuments } from "./manuscript";
import { loadFigModel, loadManifest, safeJoin } from "./model";
import { journal } from "./journal";
import { ValidationError } from "./errors";

export interface InboxCaller { identity?: AgentIdentity; session?: SessionRef }
export function inboxSession(caller: InboxCaller = {}): SessionRef {
  if (caller.session) return caller.session;
  const id = caller.identity ?? detectAgentIdentity(process.env);
  return { id: id.sessionId ?? `cli-${process.ppid}`, name: id.product ?? id.client, client: id.client };
}
export function inboxAuthor(caller: InboxCaller = {}) {
  const session = inboxSession(caller);
  return { kind: "agent" as const, name: session.name, client: caller.identity?.client ?? session.client ?? "cli" };
}
export async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** Includes the nearest existing ancestor, so new paths cannot traverse an escaping symlink. */
export async function confinedInboxPath(root: string, rel: string): Promise<string> {
  const file = safeJoin(root, rel), base = await fs.realpath(root);
  let ancestor = file;
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      const relative = path.relative(base, real);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new ValidationError(`path escapes project root: ${rel}`);
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw e;
      ancestor = parent;
    }
  }
}

export async function readPresence(root: string) {
  const dir = await confinedInboxPath(root, PRESENCE_DIR_REL);
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const result = await Promise.all(names.filter(n => !n.startsWith(".") && n.endsWith(".json")).map(async n => {
    const text = await readOptional(await confinedInboxPath(root, `${PRESENCE_DIR_REL}/${n}`));
    return text ? parsePresence(text) : null;
  }));
  return result.filter((s): s is NonNullable<typeof s> => !!s);
}
export function localPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export async function readAnnotationEvents(root: string): Promise<AnnotationEvent[]> {
  return parseLedger(await readOptional(await confinedInboxPath(root, ANNOTATIONS_REL)) ?? "");
}
export async function readAnnotationState(root: string) {
  const [events, sessions] = await Promise.all([readAnnotationEvents(root), readPresence(root)]);
  const now = Date.now();
  const presence = liveSessions(sessions, now, { host: os.hostname(), pidAlive: localPidAlive });
  const liveness = { now, liveSessionIds: new Set(presence.keys()), watchingSessionIds: new Set([...presence.values()].filter(s => s.watching).map(s => s.id)) };
  return { events, presence, liveness, state: foldAnnotations(events, liveness) };
}

/** One O_APPEND write per complete event. Claim records must fit in 4 KiB. */
export async function appendAnnotationEvents(root: string, events: readonly AnnotationEvent[]): Promise<void> {
  const lines = events.map(serializeEvent);
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === "claim" && Buffer.byteLength(lines[i]) > 4096) throw new ValidationError("claim record exceeds 4096 bytes");
  }
  const file = await confinedInboxPath(root, ANNOTATIONS_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "a+");
  try {
    // Preserve an incomplete last record, but separate the next event from it.
    // Concurrent recovery prefixes only add harmless blank lines.
    const { size } = await handle.stat();
    const tail = Buffer.alloc(1);
    if (size) await handle.read(tail, 0, 1, size - 1);
    const separator = size && tail[0] !== 10 ? "\n" : "";
    for (let i = 0; i < lines.length; i++) {
      const bytes = Buffer.from((i === 0 ? separator : "") + lines[i]);
      const written = await handle.write(bytes);
      if (written.bytesWritten !== bytes.length) throw new Error("incomplete annotation append");
      const ev = events[i];
      await journal(root, { action: `annotation_${ev.kind}`, target: "target" in ev ? ev.target : "id" in ev ? ev.id : undefined, client: ev.client, session: ev.session, author: ev.author });
    }
    await handle.sync();
  } finally { await handle.close(); }
}
export async function appendAnnotationEvent(root: string, event: AnnotationEvent): Promise<void> {
  await appendAnnotationEvents(root, [event]);
}

export async function readInbox(root: string) {
  const [ledger, comments, documents, manifest] = await Promise.all([
    readAnnotationState(root), listProjectComments(root), listDocuments(root), loadManifest(root),
  ]);
  const authors = (manifest as unknown as { authors?: { name: string }[]; author?: string }).authors?.map(a => a.name) ?? [];
  const items = buildInbox({ state: ledger.state, comments, liveness: ledger.liveness, humanAuthors: authors });
  return { ...ledger, items, documents };
}
export type InboxSnapshot = Awaited<ReturnType<typeof readInbox>>;
export interface ListInboxOptions { filter?: InboxFilter; query?: string; mine?: boolean }
export async function prepareInboxFilter(root: string, snapshot: InboxSnapshot, opts: ListInboxOptions, caller: InboxCaller = {}) {
  const filter = { ...parseInboxQuery(opts.query ?? "", { docs: snapshot.documents.map(d => d.path) }), ...opts.filter };
  const session = inboxSession(caller);
  if (opts.mine) filter.holder = session.id;
  try {
    const figures = filter.figure ? (await loadFigModel(root)).project.figures : [];
    const resolved = resolveInboxFilter(filter, snapshot.documents.map(d => d.path), figures);
    return { filter: resolved.filter, context: { ...resolved.context, sessionId: session.id } };
  } catch (e) { throw new ValidationError((e as Error).message); }
}
export async function listInbox(root: string, opts: ListInboxOptions = {}, caller: InboxCaller = {}) {
  const snapshot = await readInbox(root);
  const { filter, context } = await prepareInboxFilter(root, snapshot, opts, caller);
  return { items: filterInbox(snapshot.items, filter, context), filter };
}

export function findInboxItem(items: readonly InboxItem[], idOrText: string, doc?: string): InboxItem {
  const eligible = doc ? items.filter(i => i.doc === doc) : items;
  const exact = eligible.filter(i => i.id === idOrText);
  const needle = idOrText.toLowerCase();
  const hits = exact.length ? exact : eligible.filter(i => i.status !== "resolved" && i.status !== "withdrawn" && (i.text.toLowerCase().includes(needle) || i.anchor?.quote.toLowerCase().includes(needle)));
  if (hits.length === 1) return hits[0];
  throw new ValidationError(hits.length ? `ambiguous inbox item "${idOrText}": ${hits.map(i => `${i.doc ?? i.surface}:${i.id}`).join(", ")}` : `no open inbox item matches "${idOrText}"`);
}
function overlay(snapshot: InboxSnapshot, id: string): ItemOverlay {
  return snapshot.state.byId.get(id) ?? snapshot.state.overlays.get(id) ?? { id, claim: null, lastHolder: null, assignedTo: null, agentState: null, archived: false, replies: [], revokedSession: null, lastActivity: "", lostClaims: [] };
}
function assertWritable(snapshot: InboxSnapshot, item: InboxItem, caller: InboxCaller) {
  const session = inboxSession(caller);
  if (snapshot.state.stoppedSessions.has(session.id)) throw new ValidationError("session released by the user");
  const allowed = writeAllowed(overlay(snapshot, item.id), session, snapshot.liveness);
  if (!allowed.ok) throw new ValidationError(`${item.id}: ${allowed.reason}`);
}
function assertOpen(item: InboxItem) {
  if (item.status === "withdrawn" || item.status === "resolved") throw new ValidationError(`${item.id} is ${item.status}`);
}
export async function claimItem(root: string, id: string, opts: { note?: string; force?: boolean } = {}, caller: InboxCaller = {}) {
  const before = await readInbox(root), item = findInboxItem(before.items, id), o = overlay(before, item.id);
  const session = inboxSession(caller), author = inboxAuthor(caller);
  assertOpen(item);
  // Contention returns a holder; revocation is a refusal even on force.
  if (o.revokedSession === session.id || before.state.stoppedSessions.has(session.id)) throw new ValidationError(`${id}: released by the user`);
  const staleClaim = o.claim && !claimIsLive(o.claim, before.liveness);
  const staleAssignment = o.assignedTo && !before.liveness.liveSessionIds.has(o.assignedTo.id);
  const ev = makeClaim(item.id, session, author.client, { force: opts.force,
    ...(staleClaim || staleAssignment ? { takeover: "stale" as const } : {}),
    ...(staleClaim ? { previousClaim: { id: o.claim!.session.id, since: o.claim!.since } } : {}),
    ...(staleAssignment ? { previousAssignee: o.assignedTo!.id } : {}),
  });
  await appendAnnotationEvent(root, { ...ev, author });
  const after = await readInbox(root), result = overlay(after, item.id);
  if (result.claim?.session.id !== session.id) {
    const holder = result.claim ? { ...result.claim.session, since: result.claim.since } : result.assignedTo;
    return { id: item.id, claimed: false, holder };
  }
  if (opts.note) await replyItem(root, item.id, opts.note, { state: "working" }, caller);
  return { id: item.id, claimed: true, holder: { ...session, since: result.claim.since } };
}
export async function releaseItem(root: string, id: string, caller: InboxCaller = {}) {
  const snapshot = await readInbox(root), item = findInboxItem(snapshot.items, id);
  assertWritable(snapshot, item, caller);
  await appendAnnotationEvent(root, { ...makeRelease(item.id, "agent", inboxAuthor(caller).client, inboxSession(caller)), author: inboxAuthor(caller) });
  return { id: item.id, released: true };
}
export async function replyItem(root: string, id: string, text: string, opts: { needsInput?: boolean; state?: "working" | "info" } = {}, caller: InboxCaller = {}) {
  if (!text.trim()) throw new ValidationError("reply needs text");
  const snapshot = await readInbox(root), item = findInboxItem(snapshot.items, id);
  assertOpen(item); assertWritable(snapshot, item, caller);
  const author = inboxAuthor(caller), session = inboxSession(caller), state = opts.needsInput ? "needs-input" : opts.state;
  if (item.kind === "comment") {
    await replyToComment(root, item.id, text, { docRel: item.doc, author: author.name, client: author.client, session,
      beforeWrite: async () => { const fresh = await readInbox(root); assertWritable(fresh, findInboxItem(fresh.items, item.id), caller); },
    });
    // State also renews comment-holder activity, whose reply text lives only in the sidecar.
    await appendAnnotationEvent(root, { ...makeState(item.id, state === "needs-input" ? "needs-input" : "working", author.client, session), author });
  } else await appendAnnotationEvent(root, makeReply(item.id, author, text, author.client, { state, session }));
  return { id: item.id, replied: true };
}
export async function resolveItem(root: string, id: string, opts: { note?: string; doc?: string } = {}, caller: InboxCaller = {}) {
  const snapshot = await readInbox(root), item = findInboxItem(snapshot.items, id, opts.doc);
  assertOpen(item); assertWritable(snapshot, item, caller);
  const author = inboxAuthor(caller), session = inboxSession(caller);
  const comment = item.kind === "comment" ? await resolveProjectComment(root, item.id, { docRel: item.doc, note: opts.note, author: author.name, client: author.client, session,
    beforeWrite: async () => { const fresh = await readInbox(root); assertWritable(fresh, findInboxItem(fresh.items, item.id), caller); },
  }) : undefined;
  await appendAnnotationEvent(root, makeResolve(item.id, author.client, { note: opts.note, author, session }));
  return { ...comment, id: item.id, status: "resolved" as const };
}
export async function archiveItem(root: string, id: string, archived: boolean, caller: InboxCaller = {}) {
  const snapshot = await readInbox(root), item = findInboxItem(snapshot.items, id);
  assertWritable(snapshot, item, caller);
  await appendAnnotationEvent(root, { ...makeArchive(item.id, archived, inboxAuthor(caller).client), author: inboxAuthor(caller), session: inboxSession(caller) });
  return { id: item.id, archived };
}
