// Project-scoped IO; all folds, filters and mutations come from the pure cores.
import { get, writable } from "svelte/store";
import { currentProject } from "../shellStore";
import { fileBridge, joinPath } from "../../lib/project/types";
import { listAllComments, changeComment, commentsRevision } from "../../lib/project/commentBridge";
import { ANNOTATIONS_REL, foldAnnotations, parseLedger, serializeEvent, makeReply, makeArchive, makeReopen, makeWithdraw, type AnnotationEvent } from "../../lib/project/annotations";
import { buildInbox, filterInbox, type InboxItem } from "../../lib/project/inbox";
import { PRESENCE_DIR_REL, parsePresence, liveSessions } from "../../lib/project/presence";
import { visibleSessions } from "../../lib/project/agentRouting";
import { feedbackRevision, presenceRevision, externalManuscriptChange } from "../../lib/project/projectWatch";
import { inboxCount, inboxOpen, inboxSelection, inboxQuery, inboxDrafts } from "./inboxState";

export const inboxItems = writable<InboxItem[]>([]);
export const inboxDocuments = writable<string[]>([]);
export const inboxSessionIds = writable<ReadonlySet<string>>(new Set());
export const inboxError = writable("");
export const inboxLoaded = writable(false);
let root: string | null = null, generation = 0, wired = false;
let pending: Promise<void> | null = null, again = false;
let expiry: ReturnType<typeof setInterval> | undefined;
let consumers = 0;
function updateExpiry(): void {
  if (expiry) clearInterval(expiry);
  expiry = undefined;
  if (consumers || get(inboxOpen)) {
    void refreshInbox();
    // Expire crashed agents even without a final filesystem event.
    expiry = setInterval(() => void refreshInbox(), 5000);
  }
}
export function retainInbox(): () => void {
  initInboxStore();
  consumers++; updateExpiry();
  return () => { consumers = Math.max(0, consumers - 1); updateExpiry(); };
}

async function readSnapshot(owner: string) {
  const fb = fileBridge();
  if (!fb) throw new Error("The project is no longer available");
  const readLedger = async () => {
    const file = joinPath(owner, ANNOTATIONS_REL);
    return await fb.exists(file) ? fb.readText(file) : "";
  };
  const readSessions = async () => {
    const dir = joinPath(owner, PRESENCE_DIR_REL);
    if (!await fb.exists(dir)) return [];
    const entries = await fb.readdir?.(dir) ?? [];
    return Promise.all(entries.filter(e => !e.dir && !e.name.startsWith(".") && e.name.endsWith(".json")).map(async e => {
      try { return parsePresence(await fb.readText(joinPath(dir, e.name))); } catch { return null; }
    }));
  };
  const [text, all, sessions] = await Promise.all([readLedger(), listAllComments(owner), readSessions()]);
  const now = Date.now(), live = liveSessions(sessions.filter(s => s !== null), now);
  const state = foldAnnotations(parseLedger(text), { now, liveSessionIds: new Set(live.keys()) });
  const liveness = { now, liveSessionIds: new Set(live.keys()), watchingSessionIds: new Set(visibleSessions([...live.values()], state.stoppedSessions).filter(s => s.watching).map(s => s.id)) };
  return { items: buildInbox({ state, comments: all.comments, liveness, humanAuthors: all.manifest.authors?.map(a => a.name) }), documents: all.documents.map(d => d.path), sessionIds: liveness.liveSessionIds };
}

export function refreshInbox(): Promise<void> {
  again = true;
  if (pending) return pending;
  pending = (async () => {
    while (again) {
      again = false;
      const owner = root, epoch = generation;
      if (!owner) continue;
      try {
        const result = await readSnapshot(owner);
        if (owner !== root || epoch !== generation) continue;
        inboxItems.set(result.items); inboxDocuments.set(result.documents); inboxSessionIds.set(result.sessionIds);
        inboxCount.set(filterInbox(result.items, {}).length);
        inboxError.set(""); inboxLoaded.set(true);
      } catch (e) { if (owner === root && epoch === generation) inboxError.set((e as Error).message); }
    }
  })().finally(() => { pending = null; });
  return pending;
}

export function initInboxStore(): void {
  if (wired) return;
  wired = true;
  currentProject.subscribe(p => {
    const next = p?.path ?? null;
    if (next === root) return;
    const first = generation === 0;
    root = next; generation++;
    if (!first) inboxOpen.set(false); inboxSelection.set(null); inboxQuery.set(""); inboxDrafts.clear();
    inboxItems.set([]); inboxDocuments.set([]); inboxSessionIds.set(new Set()); inboxCount.set(0); inboxError.set(""); inboxLoaded.set(false);
    void refreshInbox();
  });
  for (const store of [feedbackRevision, presenceRevision, commentsRevision, externalManuscriptChange]) {
    let first = true;
    store.subscribe(() => { if (first) first = false; else void refreshInbox(); });
  }
  inboxOpen.subscribe(updateExpiry);
}

export async function changeInboxItem(item: InboxItem, action: "reply" | "archive" | "reopen" | "withdraw", text = ""): Promise<void> {
  const owner = root, epoch = generation, fb = fileBridge();
  if (!owner || !fb?.feedbackAppend) throw new Error("Open a project to change an inbox item");
  const latest = (await readSnapshot(owner)).items.find(i => i.id === item.id && i.doc === item.doc);
  if (epoch !== generation) throw new Error("Project changed before the item could be saved");
  if (!latest) throw new Error("This inbox item is no longer available");
  item = latest;
  if (action === "withdraw" && (item.kind !== "annotation" || item.thread[0]?.kind !== "human")) throw new Error("Only your annotations can be withdrawn");
  if (action === "reply" && ["resolved", "withdrawn"].includes(item.status)) throw new Error("Reopen the item before replying");
  let event: AnnotationEvent | undefined;
  if (item.kind === "comment" && (action === "reply" || action === "reopen")) {
    await changeComment(owner, item.doc!, item.id, action === "reply" ? { kind: "reply", body: text } : { kind: "reopen" });
  } else if (action === "reply") event = makeReply(item.id, { kind: "human", name: "You" }, text, "human");
  else if (action === "archive") event = makeArchive(item.id, !item.archived, "human");
  else if (action === "reopen") event = makeReopen(item.id, "human");
  else event = makeWithdraw(item.id, "human");
  if (event) {
    if (epoch !== generation) throw new Error("Project changed before the item could be saved");
    if (await fb.feedbackAppend(joinPath(owner, ANNOTATIONS_REL), serializeEvent(event)) === false) throw new Error("The item was not saved. Retry the action.");
    feedbackRevision.update(n => n + 1);
  }
  await refreshInbox();
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  const w = window as unknown as { __fluxInbox?: { items: InboxItem[]; refresh: typeof refreshInbox } };
  inboxItems.subscribe(items => { w.__fluxInbox = { items, refresh: refreshInbox }; });
}
