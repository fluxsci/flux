// The inbox: one model over everything the user asked agents to look at, meaning
// annotations (the ledger) AND Paper margin comments (their sidecars), with one
// status overlay (claims, routes, needs-input, archive) from the ledger. The CLI
// (`flux inbox`), the MCP tools (`list_inbox`, `wait_for_inbox`) and the app's
// Inbox panel all build their view here, so an agent and the user always see the
// same items with the same statuses. Pure module: callers supply what they read.

import {
  annotationThread,
  parseRoute,
  claimIsLive,
  describeStamp,
  statusChip,
  statusOf,
  parseTags,
  type AnnotationItem,
  type AnnotationState,
  type ContextStamp,
  type ItemOverlay,
  type ItemStatus,
  type LivenessContext,
  type Route,
  type SessionRef,
  type ThreadMessage,
} from "./annotations";
import { describeTarget, formatTarget, targetDeckId, targetFigureId, type TargetRef } from "./targets";
import { createFigureReferenceResolver } from "../figureReferences";

/** A margin-comment thread as flux-core / the GUI read it from a sidecar. */
export interface InboxComment {
  id: string;
  doc: string;
  anchor: { start: number; end: number; quote: string; prefix?: string; suffix?: string };
  resolved: boolean;
  messages: { author: string; body: string; createdAt: string; kind?: "agent" | "human" }[];
}

export type InboxSurface = "paper" | "figure" | "slide" | "present" | "reader" | "library" | "home" | "unknown";

export interface InboxItem {
  id: string;
  kind: "annotation" | "comment";
  surface: InboxSurface;
  /** Human summary of where the item points ("figure · plot "density" › series "control""). */
  where: string;
  /** The first message: the annotation text, or the comment's first message. */
  text: string;
  tags: string[];
  status: ItemStatus;
  /** The chip every surface shows ("Queued → heron", "Claimed by heron", "heron needs your input"). */
  chip: string;
  archived: boolean;
  route: Route;
  claimedBy: (SessionRef & { since: string; live: boolean }) | null;
  assignedTo: SessionRef | null;
  lastHolder: SessionRef | null;
  revokedSession?: string | null;
  createdAt: string;
  lastActivity: string;
  doc?: string;
  figureIds: string[];
  deckIds: string[];
  citekey?: string;
  /** Project-relative PNG (annotations with a picture). */
  image?: string;
  targets: TargetRef[];
  thread: ThreadMessage[];
  context: ContextStamp | null;
  anchor?: InboxComment["anchor"];
}

export interface InboxBuildInput {
  state: AnnotationState;
  comments: readonly InboxComment[];
  liveness: LivenessContext & { watchingSessionIds?: ReadonlySet<string> };
  /** Comment authors that are the user (project author names; "You" is always human). */
  humanAuthors?: readonly string[];
}

function surfaceOf(c: ContextStamp | null): InboxSurface {
  const s = c?.surface;
  return s === "paper" || s === "figure" || s === "slide" || s === "present" || s === "reader" || s === "library" || s === "home" ? s : "unknown";
}

function stampTargets(c: ContextStamp | null): TargetRef[] {
  if (!c) return [];
  if (c.targets?.length) return c.targets;
  // Older stamps (before targets existed) still say what was selected.
  const out: TargetRef[] = [];
  if (c.doc?.path) out.push({ kind: "doc", path: c.doc.path, from: c.doc.from, to: c.doc.to, quote: c.doc.quote });
  if (c.activeFigureId) {
    if (c.partSelection) out.push({ kind: "part", figureId: c.activeFigureId, elementId: c.partSelection.elementId, partId: c.partSelection.partId });
    else for (const id of c.selection ?? []) out.push({ kind: "element", figureId: c.activeFigureId, elementId: id });
    if (!out.length) out.push({ kind: "figure", figureId: c.activeFigureId, ...(c.activeFigureName ? { name: c.activeFigureName } : {}) });
  }
  if (c.reader?.citekey && c.reader.page) out.push({ kind: "passage", citekey: c.reader.citekey, page: c.reader.page, quote: c.reader.selection });
  return out;
}

/** Expired presence changes the view, never the persisted ledger. */
function effectiveOverlay<T extends ItemOverlay>(o: T, ctx: LivenessContext): T {
  const claim = o.claim && !claimIsLive(o.claim, ctx) ? null : o.claim;
  const assignedTo = o.assignedTo && ctx.liveSessionIds && !ctx.liveSessionIds.has(o.assignedTo.id) ? null : o.assignedTo;
  return { ...o, claim, assignedTo, lastHolder: o.claim && !claim ? o.claim.session : o.assignedTo && !assignedTo ? o.assignedTo : o.lastHolder,
    disconnected: o.claim && !claim ? o.claim.session : !claim && o.assignedTo && !assignedTo ? o.assignedTo : undefined,
    agentState: !claim && (o.claim || o.assignedTo && !assignedTo) ? null : o.agentState };
}

function overlayView(o: ItemOverlay | undefined, liveness: InboxBuildInput["liveness"]) {
  const claim = o?.claim ?? null;
  return {
    claimedBy: claim ? { ...claim.session, since: claim.since, live: claimIsLive(claim, liveness) } : null,
    assignedTo: o?.assignedTo ?? null,
    lastHolder: o?.lastHolder ?? null,
    archived: o?.archived ?? false,
    revokedSession: o?.revokedSession ?? null,
  };
}

function annotationItem(a: AnnotationItem, liveness: InboxBuildInput["liveness"]): InboxItem {
  a = effectiveOverlay(a, liveness);
  const c = a.note.context;
  const originalRoute = a.note.route;
  const routeSessions = originalRoute && typeof originalRoute === "object" && "session" in originalRoute ? [originalRoute.session] : [];
  const text = parseRoute(a.note.text, routeSessions).text;
  const targets = stampTargets(c);
  const figureIds = [...new Set([c?.activeFigureId, ...targets.map(targetFigureId)].filter((x): x is string => !!x))];
  const deckIds = [...new Set([c?.slide?.deckId, c?.present?.deckId, ...targets.map(targetDeckId)].filter((x): x is string => !!x))];
  return {
    id: a.note.id,
    kind: "annotation",
    surface: surfaceOf(c),
    where: describeStamp(c),
    text,
    tags: a.tags,
    status: statusOf(a),
    chip: statusChip(a, liveness),
    route: a.route,
    ...overlayView(a, liveness),
    createdAt: a.note.ts,
    lastActivity: a.lastActivity,
    ...(c?.doc?.path ? { doc: c.doc.path } : {}),
    figureIds,
    deckIds,
    ...(c?.reader?.citekey ? { citekey: c.reader.citekey } : {}),
    ...(c?.snapshot?.image ? { image: c.snapshot.image } : {}),
    targets,
    thread: annotationThread(a).map((m, i) => i === 0 ? { ...m, text } : m),
    context: c,
  };
}

function commentItem(t: InboxComment, o: ItemOverlay | undefined, input: InboxBuildInput): InboxItem {
  const human = new Set(["You", ...(input.humanAuthors ?? [])]);
  const thread: ThreadMessage[] = t.messages.map((m) => ({ kind: m.kind ?? (human.has(m.author) ? "human" : "agent"), author: m.author, text: m.body, ts: m.createdAt }));
  const first = t.messages[0];
  const humanText = thread.filter((m) => m.kind === "human").map((m) => m.text).join("\n");
  const overlay = o ? effectiveOverlay(o, input.liveness) : null;
  const pseudo = { ...(overlay ?? emptyView(t.id)), resolved: t.resolved, withdrawn: false };
  if (pseudo.agentState === "needs-input" && thread.some(m => m.kind === "human" && m.ts > pseudo.lastActivity)) pseudo.agentState = null;
  const quote = t.anchor.quote.length > 48 ? t.anchor.quote.slice(0, 45) + "…" : t.anchor.quote;
  return {
    id: t.id,
    kind: "comment",
    surface: "paper",
    where: `${t.doc} · "${quote}"`,
    text: first?.body ?? "",
    tags: parseTags([first?.body ?? "", humanText].join("\n")),
    status: statusOf(pseudo),
    chip: statusChip(pseudo, input.liveness),
    route: overlay?.route ?? (overlay?.assignedTo ? { session: overlay.assignedTo } : "none"),
    ...overlayView(overlay ?? undefined, input.liveness),
    createdAt: first?.createdAt ?? "",
    lastActivity: [overlay?.lastActivity, ...t.messages.map((m) => m.createdAt)].filter((x): x is string => !!x).sort().at(-1) ?? "",
    doc: t.doc,
    figureIds: [],
    deckIds: [],
    targets: [{ kind: "doc", path: t.doc, from: t.anchor.start, to: t.anchor.end, quote: t.anchor.quote }],
    thread,
    context: null,
    anchor: t.anchor,
  };
}

function emptyView(id: string): ItemOverlay {
  return { id, claim: null, lastHolder: null, assignedTo: null, agentState: null, archived: false, replies: [], revokedSession: null, lastActivity: "", lostClaims: [] };
}

/** Every item, annotations then comments, each in creation order. */
export function buildInbox(input: InboxBuildInput): InboxItem[] {
  const out = input.state.items.map((a) => annotationItem(a, input.liveness));
  for (const t of input.comments) out.push(commentItem(t, input.state.overlays.get(t.id), input));
  return out;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const DEFAULT_STATUSES: readonly ItemStatus[] = ["open", "queued", "claimed", "needs-input"];

export interface InboxFilter {
  kind?: "annotation" | "comment";
  surface?: InboxSurface;
  /** A document path, basename, or basename without extension ("draft_1"). */
  doc?: string;
  /** A figure id, or any alias the caller provides (name, referenceKey, "Figure 3"). */
  figure?: string;
  deck?: string;
  /** Every tag must be present. */
  tag?: string[];
  /** Default: open, queued, claimed, needs-input. */
  status?: ItemStatus[] | "all";
  /** Include archived items (default: hide them). */
  archived?: boolean;
  /** ISO time: created or active since. */
  since?: string;
  /** Case-insensitive substring over the text and the thread. */
  text?: string;
  /** Items assigned to or claimed by this session name/id. */
  holder?: string;
  claimed?: "me" | "others" | "none" | "any";
}

export interface FilterContext {
  sessionId?: string;
  /** Figure id → aliases (display name, nickname, referenceKey, "Figure 3", …). */
  figureAliases?: ReadonlyMap<string, readonly string[]>;
}

/** Resolve names once at the IO boundary; ambiguity is identical in both engines. */
export function resolveInboxFilter(filter: InboxFilter, docs: readonly string[], figures: readonly { id: string; name: string; nickname?: string; referenceKey?: string }[] = []) {
  const f = { ...filter };
  if (f.doc) {
    const candidates = docCandidates(docs, f.doc);
    if (candidates.length > 1) throw new Error(`ambiguous document "${f.doc}": ${candidates.join(", ")}`);
    if (candidates.length === 1) f.doc = candidates[0];
  }
  const figureAliases = new Map(figures.map(fig => [fig.id, [fig.name, fig.nickname ?? "", fig.referenceKey ?? ""]]));
  if (f.figure) {
    const resolve = createFigureReferenceResolver(figures.map(fig => ({ label: fig.referenceKey ?? fig.id, id: fig.id })));
    const found = resolve(f.figure.replace(/^@/, ""));
    if (found) f.figure = found.ref.id;
    else {
      const wanted = f.figure.toLowerCase();
      const hits = figures.filter(fig => [fig.id, ...figureAliases.get(fig.id)!].some(n => n.toLowerCase() === wanted));
      if (hits.length > 1) throw new Error(`ambiguous figure "${f.figure}": ${hits.map(fig => fig.id).join(", ")}`);
    }
  }
  return { filter: f, context: { figureAliases } };
}

const norm = (s: string) => s.trim().toLowerCase();
const stripExt = (s: string) => s.replace(/\.(qmd|md|markdown)$/i, "");
const base = (p: string) => p.split("/").pop() ?? p;

export function docMatches(docPath: string | undefined, want: string): boolean {
  if (!docPath) return false;
  const d = norm(docPath), w = norm(want).replace(/^\.\//, "");
  return d === w || norm(base(docPath)) === w || norm(stripExt(base(docPath))) === norm(stripExt(w)) || norm(stripExt(docPath)) === norm(stripExt(w));
}

/** Distinct documents a doc filter would match. More than one means "ambiguous: name the path". */
export function docCandidates(docs: readonly string[], want: string): string[] {
  return [...new Set(docs.filter((d) => docMatches(d, want)))];
}

function figureMatches(item: InboxItem, want: string, ctx: FilterContext): boolean {
  const w = norm(want);
  return item.figureIds.some((id) => norm(id) === w || (ctx.figureAliases?.get(id) ?? []).some((a) => norm(a) === w));
}

export function matchesFilter(item: InboxItem, f: InboxFilter, ctx: FilterContext = {}): boolean {
  const statuses = f.status === "all" ? null : f.status?.length ? f.status : DEFAULT_STATUSES;
  if (statuses && !statuses.includes(item.status)) return false;
  if (item.archived && !f.archived) return false;
  if (f.kind && item.kind !== f.kind) return false;
  if (f.surface && item.surface !== f.surface) return false;
  if (f.doc && !docMatches(item.doc, f.doc)) return false;
  if (f.figure && !figureMatches(item, f.figure, ctx)) return false;
  if (f.deck && !item.deckIds.some((d) => norm(d) === norm(f.deck!))) return false;
  if (f.tag?.length && !f.tag.every((t) => item.tags.includes(norm(t).replace(/^#/, "")))) return false;
  if (f.since && !(item.createdAt >= f.since || item.lastActivity >= f.since)) return false;
  if (f.claimed) {
    const holder = item.claimedBy?.live ? item.claimedBy.id : null;
    if (f.claimed === "me" && (!holder || holder !== ctx.sessionId)) return false;
    if (f.claimed === "others" && (!holder || holder === ctx.sessionId)) return false;
    if (f.claimed === "none" && holder) return false;
    if (f.claimed === "any" && !holder) return false;
  }
  if (f.holder) {
    const h = norm(f.holder).replace(/^@/, "");
    const who = [item.claimedBy?.live ? item.claimedBy.name : undefined, item.claimedBy?.live ? item.claimedBy.id : undefined, item.assignedTo?.name, item.assignedTo?.id].filter(Boolean).map((x) => norm(x!));
    if (!who.includes(h)) return false;
  }
  if (f.text) {
    const t = norm(f.text);
    if (!(norm(item.text).includes(t) || item.thread.some((m) => norm(m.text).includes(t)) || norm(item.where).includes(t))) return false;
  }
  return true;
}

export function filterInbox(items: readonly InboxItem[], f: InboxFilter, ctx: FilterContext = {}): InboxItem[] {
  return items.filter((i) => matchesFilter(i, f, ctx));
}

const STATUS_RANK: Record<ItemStatus, number> = { "needs-input": 0, open: 1, queued: 2, claimed: 3, resolved: 4, withdrawn: 5 };

/** Inbox order: needs-input first, then open, queued, claimed, resolved; newest first within a group. */
export function sortForInbox(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.lastActivity || b.createdAt).localeCompare(a.lastActivity || a.createdAt));
}

// ---------------------------------------------------------------------------
// Plain-language filter typing: the Inbox search box, and `flux inbox "…"`
// ---------------------------------------------------------------------------

const SURFACE_WORDS: Record<string, InboxSurface> = {
  paper: "paper", doc: "paper", docs: "paper", document: "paper", documents: "paper", manuscript: "paper",
  figure: "figure", figures: "figure", slide: "slide", slides: "slide", deck: "slide", present: "present",
  reader: "reader", pdf: "reader", library: "library", home: "home", unknown: "unknown",
};
const STATUS_WORDS: Record<string, ItemStatus[] | "all"> = {
  open: ["open"], queued: ["queued"], claimed: ["claimed"], working: ["claimed"], "needs-input": ["needs-input"],
  waiting: ["needs-input"], resolved: ["resolved"], done: ["resolved"], withdrawn: ["withdrawn"], all: "all",
};

/**
 * `draft_1 #claude figure` → {doc: "draft_1", tag: ["claude"], surface: "figure"}.
 * Grammar: `#tag`, `@holder`, `key:value` (kind, doc, fig|figure, deck, surface,
 * status, since), bare surface/status words, `archived`, `comments`/
 * `annotations`; a bare word that names a known document is a doc filter;
 * everything else is free text.
 */
export function parseInboxQuery(q: string, opts: { docs?: readonly string[] } = {}): InboxFilter {
  const f: InboxFilter = {};
  const text: string[] = [];
  const tokens = q.match(/"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const tok = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    const low = tok.toLowerCase();
    const kv = /^([a-z]+):(.+)$/i.exec(tok);
    if (tok.startsWith("#") && tok.length > 1) (f.tag ??= []).push(low.slice(1));
    else if (tok.startsWith("@") && tok.length > 1) f.holder = tok.slice(1);
    else if (kv) {
      const [, k, v] = kv;
      const key = k.toLowerCase();
      if (key === "kind") f.kind = v.toLowerCase().startsWith("c") ? "comment" : "annotation";
      else if (key === "doc") f.doc = v;
      else if (key === "fig" || key === "figure") f.figure = v;
      else if (key === "deck") f.deck = v;
      else if (key === "surface" && SURFACE_WORDS[v.toLowerCase()]) f.surface = SURFACE_WORDS[v.toLowerCase()];
      else if (key === "status" && STATUS_WORDS[v.toLowerCase()]) f.status = STATUS_WORDS[v.toLowerCase()];
      else if (key === "since") f.since = v;
      else text.push(tok);
    } else if (SURFACE_WORDS[low] && !f.surface) f.surface = SURFACE_WORDS[low];
    else if (STATUS_WORDS[low] && !f.status) f.status = STATUS_WORDS[low];
    else if (low === "archived") f.archived = true;
    else if (low === "comments" || low === "comment") f.kind = "comment";
    else if (low === "annotations" || low === "annotation") f.kind = "annotation";
    else if (opts.docs && !f.doc && docCandidates(opts.docs, tok).length) f.doc = tok;
    else text.push(tok);
  }
  if (text.length) f.text = text.join(" ");
  return f;
}

/** The chips the Inbox shows for a filter (and the CLI echoes). */
export function describeFilter(f: InboxFilter): string[] {
  const out: string[] = [];
  if (f.kind) out.push(`kind:${f.kind}`);
  if (f.surface) out.push(`surface:${f.surface}`);
  if (f.doc) out.push(`doc:${f.doc}`);
  if (f.figure) out.push(`figure:${f.figure}`);
  if (f.deck) out.push(`deck:${f.deck}`);
  for (const t of f.tag ?? []) out.push(`#${t}`);
  if (f.holder) out.push(`@${f.holder}`);
  if (f.status) out.push(`status:${f.status === "all" ? "all" : f.status.join(",")}`);
  if (f.archived) out.push("archived");
  if (f.since) out.push(`since:${f.since}`);
  if (f.text) out.push(`"${f.text}"`);
  return out;
}

// ---------------------------------------------------------------------------
// Delivery: which items a watching session receives
// ---------------------------------------------------------------------------

export type WatchSpec =
  | { mode: "queue" }
  | { mode: "annotations"; filter?: InboxFilter }
  | { mode: "filter"; filter: InboxFilter };

/**
 * The ONE routing rule (plan §7.9), used by the MCP wait, the CLI wait-inbox
 * and the app:
 * - an item assigned to this session is always delivered;
 * - an item assigned to someone else, or routed to the inbox ("none"), never is;
 * - "any" items go to sessions watching annotations/filter whose filter matches;
 * - nothing resolved, withdrawn, archived, or held by another live session.
 */
export function deliverableTo(item: InboxItem, session: SessionRef, watch: WatchSpec, ctx: FilterContext = {}): boolean {
  if (item.revokedSession === session.id) return false;
  if (item.status === "resolved" || item.status === "withdrawn" || item.archived) return false;
  if (item.claimedBy && item.claimedBy.id !== session.id && item.claimedBy.live) return false;
  if (item.assignedTo) return item.assignedTo.id === session.id;
  if (watch.mode === "queue") return false;
  if (item.route !== "any") return false;
  const f = watch.filter ?? {};
  return matchesFilter(item, { ...f, archived: false }, ctx);
}

// ---------------------------------------------------------------------------
// Packets: what an agent receives per item (list_inbox packets, wait_for_inbox)
// ---------------------------------------------------------------------------

export interface InboxPacket {
  id: string;
  kind: InboxItem["kind"];
  status: ItemStatus;
  chip: string;
  where: string;
  text: string;
  tags: string[];
  route: string;
  claimedBy: string | null;
  assignedTo: string | null;
  createdAt: string;
  targets: { ref: string; description: string }[];
  thread: ThreadMessage[];
  image?: string;
  doc?: string;
  anchor?: InboxComment["anchor"];
  /** Current state of what the item points at, filled by the caller (doc paragraph, element summary, …). */
  current?: Record<string, unknown>;
}

export function routeLabel(r: Route): string {
  if (r === "none") return "inbox";
  if (r === "any") return "any";
  if ("session" in r) return `@${r.session.name}`;
  return `new ${r.background}`;
}

export function toPacket(item: InboxItem, current?: Record<string, unknown>): InboxPacket {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    chip: item.chip,
    where: item.where,
    text: item.text,
    tags: item.tags,
    route: routeLabel(item.route),
    claimedBy: item.claimedBy?.name ?? null,
    assignedTo: item.assignedTo?.name ?? null,
    createdAt: item.createdAt,
    targets: item.targets.map((t) => ({ ref: formatTarget(t), description: describeTarget(t) })),
    thread: item.thread,
    ...(item.image ? { image: item.image } : {}),
    ...(item.doc ? { doc: item.doc } : {}),
    ...(item.anchor ? { anchor: item.anchor } : {}),
    ...(current ? { current } : {}),
  };
}
