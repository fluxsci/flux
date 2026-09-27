// Renderer IO over the shared annotation fold and inbox. One append publishes
// note + optional withdrawal/assignment, always after its picture is durable.
import { get, writable, derived } from "svelte/store";
import { fileBridge, joinPath } from "../../lib/project/types";
import { ANNOTATIONS_REL, ANNOTATION_IMAGES_REL, foldAnnotations, parseLedger, serializeEvent, makeNote, makeWithdraw, makeAssign, makeRelease, makeReleaseSession,
  type AnnotationState, type ContextStamp, type Route, type AnnotationEvent } from "../../lib/project/annotations";
import { buildInbox, sortForInbox, type InboxItem } from "../../lib/project/inbox";
import { liveSessions, parsePresence, PRESENCE_DIR_REL, type PresenceSession } from "../../lib/project/presence";
import { feedbackRevision, presenceRevision } from "../../lib/project/projectWatch";
import { currentProject } from "../shellStore";
import { annotationOpen, closeAnnotation, discardAnnotationBuffer } from "./annotateChord";
import { requestInbox } from "../inbox/inboxState";
import { pushToast } from "../../lib/toast";
import { sessions } from "./sessionState";
import { visibleSessions } from "../../lib/project/agentRouting";
export { sessions } from "./sessionState";

export { backgroundAvailable } from "../inbox/backgroundState";

const presenceConsumers = writable(0);
const presenceVisible = derived([annotationOpen, presenceConsumers], ([open, count]) => open || count > 0);
export function retainPresence(): () => void {
  initAnnotationStore();
  presenceConsumers.update(n => n + 1);
  return () => presenceConsumers.update(n => Math.max(0, n - 1));
}

export const annotationState = writable<AnnotationState>(foldAnnotations([]));
export const editAnnotationRequest = writable<InboxItem | null>(null);
export const projectGeneration = writable(0);
export const annotationRoute = writable<Route>("none");
export const annotationInbox = derived([annotationState, sessions], ([state, presence]) => {
  const live = liveSessions(presence, Date.now());
  return sortForInbox(buildInbox({ state, comments: [], liveness: { now: Date.now(), liveSessionIds: new Set(live.keys()),
    watchingSessionIds: new Set([...live.values()].filter(s => s.watching).map(s => s.id)) } }));
});
let root: string | null = null, generation = 0, refreshId = 0, wired = false;
let previous = new Map<string, string>();
let presence: PresenceSession[] = [];
function publishSessions(): void {
  sessions.set(visibleSessions([...liveSessions(presence, Date.now()).values()], get(annotationState).stoppedSessions));
}
let presenceTimer: ReturnType<typeof setTimeout> | undefined;
let lastPresenceRead = 0;
const routeKey = () => `flux.annotate.route:${root ?? ""}`;
export function rememberRoute(route: Route): void {
  annotationRoute.set(route);
  if (root) try { localStorage.setItem(routeKey(), JSON.stringify(route)); } catch { /* preferences unavailable */ }
}
export async function refreshAnnotations(toastNew = false): Promise<void> {
  const ownerRoot = root, owner = generation, id = ++refreshId;
  if (!ownerRoot) return;
  const fb = fileBridge();
  if (!fb) return;
  let text = "";
  try { text = await fb.readText(joinPath(ownerRoot, ANNOTATIONS_REL)); }
  catch (e) { if (await fb.exists(joinPath(ownerRoot, ANNOTATIONS_REL))) throw e; }
  if (owner !== generation || id !== refreshId) return;
  const state = foldAnnotations(parseLedger(text));
  annotationState.set(state);
  publishSessions();
  const items = get(annotationInbox);
  const next = new Map<string, string>();
  for (const item of items) {
    const key = `${item.status}:${item.claimedBy?.id ?? ""}:${item.lastActivity}`;
    next.set(item.id, key);
    if (!toastNew || !previous.has(item.id) || previous.get(item.id) === key) continue;
    const label = item.text.length > 60 ? item.text.slice(0, 57) + "…" : item.text;
    const agent = state.byId.get(item.id)?.resolvedBy ?? item.claimedBy?.name ?? item.lastHolder?.name ?? item.thread.at(-1)?.author ?? "Agent";
    if (item.status === "resolved") pushToast("success", `${agent} resolved: ${label}`);
    else if (item.status === "needs-input") pushToast("info", `${agent} has a question: ${label}`, { action: { label: "Open inbox", run: () => requestInbox(item.id) } });
    else if (item.status === "claimed" && !previous.get(item.id)?.startsWith(`claimed:${item.claimedBy?.id}:`)) pushToast("info", `${agent} claimed: ${label}`);
  }
  previous = next;
}
async function readPresence(): Promise<void> {
  presenceTimer = undefined;
  if (!get(presenceVisible) || !root) return;
  const ownerRoot = root, owner = generation, fb = fileBridge();
  if (!fb) return;
  lastPresenceRead = Date.now();
  const dir = joinPath(ownerRoot, PRESENCE_DIR_REL);
  const found: PresenceSession[] = [];
  try {
    const entries = await fb.readdir?.(dir) ?? [];
    await Promise.all(entries.filter(e => !e.dir && e.name.endsWith(".json")).map(async e => {
      try { const s = parsePresence(await fb.readText(joinPath(dir, e.name))); if (s) found.push(s); } catch { /* session exited */ }
    }));
  } catch { /* no connected sessions */ }
  if (owner !== generation || !get(presenceVisible)) return;
  presence = found;
  publishSessions();
  // Refresh expiration while visible even if a dead writer sends no more events.
  schedulePresence();
}
function schedulePresence(): void {
  if (!get(presenceVisible) || presenceTimer) return;
  presenceTimer = setTimeout(() => void readPresence(), Math.max(0, 5000 - (Date.now() - lastPresenceRead)));
}
export function initAnnotationStore(): void {
  if (wired) return;
  wired = true;
  void import("../inbox/backgroundStore").then(m => m.initBackgroundRuns());
  let initial = true;
  currentProject.subscribe(p => {
    const next = p?.path ?? null;
    if (next === root) { initial = false; return; }
    const first = initial; initial = false;
    root = next; generation++; projectGeneration.set(generation); refreshId++;
    if (!first) { closeAnnotation(); discardAnnotationBuffer(); }
    lastPresenceRead = 0;
    if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = undefined; }
    schedulePresence();
    presence = []; sessions.set([]); annotationState.set(foldAnnotations([])); previous.clear();
    annotationRoute.set("none");
    try {
      const r = JSON.parse(localStorage.getItem(routeKey()) ?? '"none"');
      if (r === "none" || r === "any" || (r && typeof r === "object" && typeof r.session?.id === "string" && typeof r.session?.name === "string")) annotationRoute.set(r);
    } catch { /* default inbox */ }
    void refreshAnnotations().catch(e => pushToast("error", "Could not read annotations", { detail: String(e) }));
  });
  let rev = get(feedbackRevision);
  feedbackRevision.subscribe(n => { if (n !== rev) { rev = n; void refreshAnnotations(true).catch(e => pushToast("error", "Could not refresh annotations", { detail: String(e) })); } });
  presenceRevision.subscribe(schedulePresence);
  presenceVisible.subscribe(open => {
    if (open) schedulePresence();
    else if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = undefined; }
  });
}
async function append(ownerRoot: string, events: AnnotationEvent[]): Promise<void> {
  const fb = fileBridge();
  if (!fb?.feedbackAppend) throw new Error("Annotations need an open project");
  if (await fb.feedbackAppend(joinPath(ownerRoot, ANNOTATIONS_REL), events.map(serializeEvent).join("")) === false) throw new Error("Annotation was not saved. Retry adding it.");
}
export async function addAnnotation(text: string, context: ContextStamp, route: Route, opts: { replaces?: string; png?: Uint8Array | null } = {}): Promise<void> {
  const ownerRoot = root, owner = generation;
  if (!ownerRoot) throw new Error("Demo project — annotations are not saved");
  if (!text.trim()) return;
  const note = makeNote(text.trim(), structuredClone(context), "human", route);
  if (opts.png && note.context?.snapshot) {
    const fb = fileBridge();
    if (!fb) throw new Error("The project is no longer available");
    const rel = `${ANNOTATION_IMAGES_REL}/${note.id}.png`;
    await fb.mkdir(joinPath(ownerRoot, ANNOTATION_IMAGES_REL));
    await fb.writeFile(joinPath(ownerRoot, rel), opts.png);
    note.context.snapshot.image = rel;
  }
  if (owner !== generation) throw new Error("Project changed while saving the annotation");
  const events: AnnotationEvent[] = opts.replaces ? [makeWithdraw(opts.replaces, "human", "edited"), note] : [note];
  if (typeof route === "object" && "session" in route) events.push(makeAssign(note.id, route.session, "human"));
  await append(ownerRoot, events);
  if (owner === generation) { await refreshAnnotations(); feedbackRevision.update(n => n + 1); }
  if (owner === generation && typeof route === "object" && "background" in route) {
    try { await (await import("../inbox/backgroundStore")).startBackgroundRun(ownerRoot, note.id, route.background); }
    catch (e) { pushToast("error", "Annotation saved; background agent could not start", { detail: (e as Error).message }); }
  }
}
export async function withdrawAnnotation(id: string): Promise<void> {
  if (!root) return;
  await append(root, [makeWithdraw(id, "human")]);
  await refreshAnnotations();
}
async function changeRouting(event: AnnotationEvent): Promise<void> {
  const ownerRoot = root, owner = generation;
  if (!ownerRoot) throw new Error("Open a project to change an inbox item");
  await append(ownerRoot, [event]);
  if (owner === generation) { await refreshAnnotations(); feedbackRevision.update(n => n + 1); }
}
export async function assignAnnotation(id: string, route: Route): Promise<void> {
  await changeRouting(makeAssign(id, route, "human"));
}
export async function unassignAnnotation(id: string): Promise<void> {
  await changeRouting(makeAssign(id, "none", "human"));
}
export async function releaseAnnotation(id: string): Promise<void> {
  await changeRouting(makeRelease(id, "human", "human"));
}
export async function annotationImage(item: InboxItem): Promise<string | null> {
  const ownerRoot = root, owner = generation;
  if (!item.image || !ownerRoot) return null;
  const bytes = await fileBridge()?.readFile(joinPath(ownerRoot, item.image));
  if (!bytes || owner !== generation) return null;
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
}

export async function stopWatching(session: PresenceSession): Promise<void> {
  await changeRouting(makeReleaseSession({ id: session.id, name: session.name, client: session.client }, "human"));
}

/** Keep publishes the picture before the complete, resolved Q&A in one append. */
export async function keepAsk(ownerRoot: string, messages: import("../../lib/project/ask").AskMessage[], context: ContextStamp, agent: string, png?: Uint8Array): Promise<void> {
  if (get(currentProject)?.path !== ownerRoot) throw new Error("Project changed while keeping Ask");
  const { keptAskEvents } = await import("../../lib/project/ask");
  const events = keptAskEvents(messages, structuredClone(context), agent);
  const note = events[0];
  if (note.kind !== "note") throw new Error("Ask exchange has no question");
  if (png && note.context?.snapshot) {
    const fb = fileBridge();
    if (!fb) throw new Error("Project is no longer available");
    const rel = `${ANNOTATION_IMAGES_REL}/${note.id}.png`;
    await fb.mkdir(joinPath(ownerRoot, ANNOTATION_IMAGES_REL));
    await fb.writeFile(joinPath(ownerRoot, rel), png);
    note.context.snapshot.image = rel;
  }
  if (get(currentProject)?.path !== ownerRoot) throw new Error("Project changed while keeping Ask");
  await append(ownerRoot, events);
  if (root === ownerRoot) await refreshAnnotations();
}
