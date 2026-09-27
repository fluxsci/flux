// The annotation ledger: what the user points at in the app (Ctrl+Shift+M), and
// the status overlay agents and the user write on annotations AND margin
// comments: claims, routes, replies, needs-input, resolve, archive.
// Event-sourced NDJSON at .meta/feedback.ndjson (the historical file name is
// kept on purpose), strictly append-only: concurrent writers never
// read-modify-write the same bytes, and the fold is deterministic in LEDGER
// ORDER (timestamps tie within a millisecond). Unknown kinds and torn lines are
// skipped, so older ledgers and future event kinds never break a reader.
// Pure module (no Svelte, no DOM, no Node): shared by the GUI and flux-core.

import { describeSnapshot, type FeedbackSnapshot } from "./feedbackCapture";
import { describeTarget, type TargetRef } from "./targets";

export const ANNOTATIONS_REL = ".meta/feedback.ndjson";
export const ANNOTATION_IMAGES_REL = ".meta/feedback";

/**
 * A claim is live while its holder shows activity on the item within this
 * window, or its presence heartbeat is fresh. A dead holder cannot block an
 * item forever.
 */
export const CLAIM_TTL_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// The context stamp: what the user was looking at (and pointing at).
// ---------------------------------------------------------------------------

export interface ContextStamp {
  surface: string;
  window?: { kind: "main" | "utility"; name?: string; index?: number } | null;
  activeFigureId?: string | null;
  activeFigureName?: string | null;
  activeCanvasId?: string | null;
  selectedFrameId?: string | null;
  selection?: string[];
  selectionSummary?: { id: string; type: string; name?: string }[];
  partSelection?: { elementId: string; partId: string } | null;
  viewport?: { panX: number; panY: number; zoom: number } | null;
  doc?: { path: string; from: number; to: number; quote: string; heading?: string } | null;
  slide?: { deckId: string; slideIndex: number; beat: number; slideId?: string } | null;
  present?: { deckId: string; slideIndex: number; beat: number } | null;
  reader?: { citekey: string; title?: string; page?: number; selection?: string; highlightId?: string; source?: "main" | { supplement: string } } | null;
  library?: { query?: string; selectedKeys?: string[]; collection?: string } | null;
  /** The resolved "this": selection plus every mark's target, most specific first. */
  targets?: TargetRef[];
  snapshot?: FeedbackSnapshot | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface SessionRef {
  id: string;
  name: string;
  client?: string;
}

export interface Author {
  kind: "agent" | "human";
  name: string;
  client?: string;
}

/**
 * Who an annotation is for (the composer's To:, or an @mention):
 * - "none": inbox only; nobody acts until told;
 * - "any": the first watching agent to claim it;
 * - a named session's queue;
 * - a fresh background agent (FluxChat F5).
 */
export type Route = "none" | "any" | { session: SessionRef } | { background: "claude" | "codex" };

interface Base { ts: string; client: string; author?: Author; session?: SessionRef | null }

export interface NoteEvent extends Base { kind: "note"; id: string; text: string; context: ContextStamp | null; route?: Route }
export interface ResolveEvent extends Base { kind: "resolve"; target: string; note?: string; author?: Author; session?: SessionRef }
export interface WithdrawEvent extends Base { kind: "withdraw"; target: string; note?: string }
export interface ClaimEvent extends Base { kind: "claim"; target: string; session: SessionRef; force?: boolean; takeover?: "stale"; previousClaim?: { id: string; since: string }; previousAssignee?: string }
export interface ReleaseEvent extends Base { kind: "release"; target: string; by: "agent" | "human"; session?: SessionRef }
export interface ReplyEvent extends Base { kind: "reply"; target: string; id: string; author: Author; text: string; state?: "working" | "needs-input" | "info"; session?: SessionRef }
export interface StateEvent extends Base { kind: "state"; target: string; state: "working" | "needs-input" | "clear"; session?: SessionRef }
export interface ReopenEvent extends Base { kind: "reopen"; target: string }
export interface ArchiveEvent extends Base { kind: "archive" | "unarchive"; target: string }
export interface AssignEvent extends Base { kind: "assign"; target: string; session: SessionRef | null }
export interface ReleaseSessionEvent extends Base { kind: "release-session"; session: SessionRef }

export type AnnotationEvent =
  | NoteEvent | ResolveEvent | WithdrawEvent | ClaimEvent | ReleaseEvent | ReplyEvent
  | StateEvent | ReopenEvent | ArchiveEvent | AssignEvent | ReleaseSessionEvent;

const KINDS = new Set<AnnotationEvent["kind"]>([
  "note", "resolve", "withdraw", "claim", "release", "reply", "state", "reopen", "archive", "unarchive", "assign", "release-session",
]);

export function annotationId(): string {
  return "fb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
export function replyId(): string {
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function serializeEvent(ev: AnnotationEvent): string {
  return JSON.stringify(ev) + "\n";
}

/** Tolerant parse: skips blank, torn and unknown-kind lines. */
export function parseLedger(text: string): AnnotationEvent[] {
  const out: AnnotationEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && KINDS.has(v.kind)) out.push(v as AnnotationEvent);
    } catch {
      // a torn trailing line (crash mid-append) never fails the whole ledger
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tags and routes, both derived from text
// ---------------------------------------------------------------------------

const TAG_RE = /(^|[\s(\[{,;])#([A-Za-z][\w-]{0,31})\b/g;

/** `#claude`, `#Stats-v2` → ["claude", "stats-v2"] (lowercased, de-duplicated). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const t = m[2].toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const MENTION_RE = /(^|[\s(\[{,;])@([A-Za-z][\w-]{0,40})\b/g;

/**
 * Route mentions in a note: `@any`, `@new` (= a Claude background agent),
 * `@new-claude`, `@new-codex`, or `@<session name>` for a KNOWN session.
 * Unknown @words stay in the text untouched (an email or a Python decorator is
 * not a route). The first route mention wins; every route mention is removed
 * from the text the agent receives.
 */
export function parseRoute(text: string, sessions: readonly SessionRef[] = []): { route: Route | null; text: string } {
  let route: Route | null = null;
  const byName = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));
  const cleaned = text.replace(MENTION_RE, (all, lead: string, word: string) => {
    const w = word.toLowerCase();
    let r: Route | null = null;
    if (w === "any") r = "any";
    else if (w === "new" || w === "new-claude") r = { background: "claude" };
    else if (w === "new-codex") r = { background: "codex" };
    else if (w === "inbox" || w === "nobody") r = "none";
    else if (byName.has(w)) r = { session: byName.get(w)! };
    if (!r) return all;
    if (!route) route = r;
    return lead;
  });
  return { route, text: cleaned.replace(/[ \t]{2,}/g, " ").trim() };
}

export function describeRoute(r: Route | null | undefined): string {
  if (!r || r === "none") return "Inbox";
  if (r === "any") return "Any watching agent";
  if ("session" in r) return r.session.name;
  return `New background agent (${r.background === "codex" ? "Codex" : "Claude Code"})`;
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

export type ItemStatus = "open" | "queued" | "claimed" | "needs-input" | "resolved" | "withdrawn";

export interface ThreadMessage {
  kind: "human" | "agent";
  author: string;
  text: string;
  ts: string;
  state?: string;
}

export interface Claim {
  session: SessionRef;
  since: string;
  /** Last claim/reply/state/resolve by the holder on this item (liveness). */
  lastActivity: string;
}

/** The status overlay every item carries, annotation or comment alike. */
export interface ItemOverlay {
  id: string;
  claim: Claim | null;
  /** Most recent holder whose claim ended without a resolve ("heron disconnected — reassign?"). */
  lastHolder: SessionRef | null;
  assignedTo: SessionRef | null;
  agentState: "working" | "needs-input" | null;
  archived: boolean;
  /** Replies written into the ledger (annotations only; comment messages live in sidecars). */
  replies: ThreadMessage[];
  /** A human pulled the claim from this session: its next write must be refused. */
  revokedSession: string | null;
  lastActivity: string;
  /** Claims that lost to an earlier live claim (reported to the losing writer). */
  lostClaims: { session: SessionRef; ts: string; holder: SessionRef }[];
}

export interface AnnotationItem extends ItemOverlay {
  kind: "annotation";
  note: NoteEvent;
  /** Ledger index of the note event (creation order). */
  seq: number;
  route: Route;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  resolveNote?: string;
  withdrawn: boolean;
  withdrawnAt?: string;
  withdrawNote?: string;
  tags: string[];
}

export interface AnnotationState {
  /** Annotations in creation order. */
  items: AnnotationItem[];
  byId: Map<string, AnnotationItem>;
  /** Status overlays for margin-comment ids (c…) referenced by claim/assign/state/archive. */
  overlays: Map<string, ItemOverlay>;
  /** Sessions the user told to stop watching, with the time (the wait returns stopped). */
  stoppedSessions: Map<string, string>;
}

function emptyOverlay(id: string, ts: string): ItemOverlay {
  return { id, claim: null, lastHolder: null, assignedTo: null, agentState: null, archived: false, replies: [], revokedSession: null, lastActivity: ts, lostClaims: [] };
}

function ms(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

/** Is `claim` still live at time `at` by activity alone (the deterministic half)? */
export function claimLiveByActivity(claim: Claim, at: number): boolean {
  return at - ms(claim.lastActivity) < CLAIM_TTL_MS;
}

export function foldAnnotations(events: readonly AnnotationEvent[], ctx?: LivenessContext): AnnotationState {
  const items: AnnotationItem[] = [];
  const byId = new Map<string, AnnotationItem>();
  const overlays = new Map<string, ItemOverlay>();
  const stoppedSessions = new Map<string, string>();

  const target = (id: string, ts: string): ItemOverlay => {
    const a = byId.get(id);
    if (a) return a;
    let o = overlays.get(id);
    if (!o) {
      o = emptyOverlay(id, ts);
      overlays.set(id, o);
    }
    return o;
  };
  const touch = (o: ItemOverlay, ts: string) => {
    if (ms(ts) >= ms(o.lastActivity)) o.lastActivity = ts;
  };
  const holderActivity = (o: ItemOverlay, s: SessionRef | undefined, ts: string) => {
    if (s && o.claim && o.claim.session.id === s.id) o.claim.lastActivity = ts;
  };
  const endClaim = (o: ItemOverlay) => {
    if (o.claim) o.lastHolder = o.claim.session;
    o.claim = null;
  };

  events.forEach((ev, seq) => {
    switch (ev.kind) {
      case "note": {
        if (byId.has(ev.id)) return; // duplicate id: first write wins
        const item: AnnotationItem = {
          ...emptyOverlay(ev.id, ev.ts),
          kind: "annotation",
          note: ev,
          seq,
          route: ev.route ?? "none",
          resolved: false,
          withdrawn: false,
          tags: parseTags(ev.text),
        };
        if (typeof item.route === "object" && "session" in item.route) item.assignedTo = item.route.session;
        items.push(item);
        byId.set(ev.id, item);
        return;
      }
      case "resolve": {
        const a = byId.get(ev.target);
        if (a) {
          if (a.withdrawn || a.resolved) return;
          a.resolved = true;
          a.resolvedAt = ev.ts;
          a.resolvedBy = ev.author?.name ?? ev.session?.name ?? ev.client;
          if (ev.note) a.resolveNote = ev.note;
          a.agentState = null;
          a.claim = null;
          touch(a, ev.ts);
        } else {
          // A comment resolve lives in its sidecar; the overlay only ends the claim.
          const o = target(ev.target, ev.ts);
          o.claim = null;
          o.agentState = null;
          touch(o, ev.ts);
        }
        return;
      }
      case "withdraw": {
        const a = byId.get(ev.target);
        if (!a || a.resolved || a.withdrawn) return;
        a.withdrawn = true;
        a.withdrawnAt = ev.ts;
        if (ev.note) a.withdrawNote = ev.note;
        a.claim = null;
        touch(a, ev.ts);
        return;
      }
      case "claim": {
        const o = target(ev.target, ev.ts);
        const a = byId.get(ev.target);
        if (a && (a.resolved || a.withdrawn)) return;
        const at = ms(ev.ts);
        // Named queue: only the assignee (or an explicit force) may claim.
        const staleAssignment = ev.takeover === "stale" && ev.previousAssignee === o.assignedTo?.id;
        if (o.assignedTo && o.assignedTo.id !== ev.session.id && !ev.force && !staleAssignment) {
          o.lostClaims.push({ session: ev.session, ts: ev.ts, holder: o.assignedTo });
          return;
        }
        if (o.claim && o.claim.session.id !== ev.session.id) {
          const activity = claimLiveByActivity(o.claim, at);
          // A stale takeover names the observed predecessor. Two contenders
          // cannot both replace it, even when they read the same stale state.
          const predecessor = !ev.previousClaim || (ev.previousClaim.id === o.claim.session.id && ev.previousClaim.since === o.claim.since);
          // A writer records its stale observation. A previously rejected
          // plain claim must not become a winner when presence later expires.
          const takeover = ev.takeover === "stale" && predecessor && !activity &&
            (!!ev.previousClaim || !ctx?.liveSessionIds?.has(o.claim.session.id));
          if (!ev.force && !takeover) {
            o.lostClaims.push({ session: ev.session, ts: ev.ts, holder: o.claim.session });
            return;
          }
          o.lastHolder = o.claim.session;
        }
        if (staleAssignment) o.assignedTo = null;
        if (ev.force && o.assignedTo && o.assignedTo.id !== ev.session.id) o.assignedTo = ev.session;
        if (o.claim && o.claim.session.id === ev.session.id) o.claim.lastActivity = ev.ts;
        else o.claim = { session: ev.session, since: ev.ts, lastActivity: ev.ts };
        if (o.revokedSession === ev.session.id) o.revokedSession = null;
        touch(o, ev.ts);
        return;
      }
      case "release": {
        const o = target(ev.target, ev.ts);
        if (!o.claim) return;
        if (ev.by === "agent" && ev.session && o.claim.session.id !== ev.session.id) return;
        if (ev.by === "human") o.revokedSession = o.claim.session.id;
        endClaim(o);
        o.agentState = null;
        touch(o, ev.ts);
        return;
      }
      case "reply": {
        const o = target(ev.target, ev.ts);
        const msg: ThreadMessage = { kind: ev.author.kind, author: ev.author.name, text: ev.text, ts: ev.ts };
        if (ev.state) msg.state = ev.state;
        o.replies.push(msg);
        if (ev.author.kind === "human") {
          if (o.agentState === "needs-input") o.agentState = null;
          const a = byId.get(ev.target);
          if (a) for (const t of parseTags(ev.text)) if (!a.tags.includes(t)) a.tags.push(t);
        } else {
          if (ev.state === "needs-input" || ev.state === "working") o.agentState = ev.state;
          holderActivity(o, ev.session, ev.ts);
        }
        touch(o, ev.ts);
        return;
      }
      case "state": {
        const o = target(ev.target, ev.ts);
        o.agentState = ev.state === "clear" ? null : ev.state;
        holderActivity(o, ev.session, ev.ts);
        touch(o, ev.ts);
        return;
      }
      case "reopen": {
        const a = byId.get(ev.target);
        if (!a || !a.resolved) return;
        a.resolved = false;
        a.resolvedAt = a.resolvedBy = a.resolveNote = undefined;
        touch(a, ev.ts);
        return;
      }
      case "archive":
      case "unarchive": {
        const o = target(ev.target, ev.ts);
        o.archived = ev.kind === "archive";
        touch(o, ev.ts);
        return;
      }
      case "assign": {
        const o = target(ev.target, ev.ts);
        o.assignedTo = ev.session;
        const a = byId.get(ev.target);
        if (a) {
          if (ev.session) a.route = { session: ev.session };
          else if (typeof a.route === "object" && "session" in a.route) a.route = "none"; // unassigned: back to the inbox
        }
        // A reassignment away from the current holder ends that claim.
        if (o.claim && ev.session && o.claim.session.id !== ev.session.id) endClaim(o);
        touch(o, ev.ts);
        return;
      }
      case "release-session": {
        stoppedSessions.set(ev.session.id, ev.ts);
        const release = (o: ItemOverlay) => {
          if (o.claim?.session.id === ev.session.id) {
            endClaim(o);
            o.agentState = null;
          }
        };
        for (const a of items) release(a);
        for (const o of overlays.values()) release(o);
        return;
      }
    }
  });
  return { items, byId, overlays, stoppedSessions };
}

// ---------------------------------------------------------------------------
// Reading the folded state
// ---------------------------------------------------------------------------

export interface LivenessContext {
  now: number;
  /** Ids of sessions with a fresh presence heartbeat. */
  liveSessionIds?: ReadonlySet<string>;
}

/** Live = the holder's presence is fresh, or it acted on the item within CLAIM_TTL_MS. */
export function claimIsLive(claim: Claim | null, ctx: LivenessContext): boolean {
  if (!claim) return false;
  if (ctx.liveSessionIds?.has(claim.session.id)) return true;
  return claimLiveByActivity(claim, ctx.now);
}

export function statusOf(o: ItemOverlay & Partial<Pick<AnnotationItem, "resolved" | "withdrawn">>): ItemStatus {
  if (o.withdrawn) return "withdrawn";
  if (o.resolved) return "resolved";
  if (o.agentState === "needs-input") return "needs-input";
  if (o.claim) return "claimed";
  if (o.assignedTo) return "queued";
  return "open";
}

/** The chip text every surface shows ("Queued → heron", "heron needs your input"). */
export function statusChip(
  o: ItemOverlay & Partial<Pick<AnnotationItem, "resolved" | "withdrawn" | "resolvedBy">>,
  ctx?: LivenessContext & { watchingSessionIds?: ReadonlySet<string> },
): string {
  const s = statusOf(o);
  switch (s) {
    case "withdrawn": return "Withdrawn";
    case "resolved": return o.resolvedBy ? `Resolved by ${o.resolvedBy}` : "Resolved";
    case "needs-input": return `${o.claim?.session.name ?? o.lastHolder?.name ?? "The agent"} needs your input`;
    case "claimed": {
      const name = o.claim!.session.name;
      if (ctx && !claimIsLive(o.claim, ctx)) return `${name} disconnected — reassign?`;
      return `Claimed by ${name}`;
    }
    case "queued": {
      const name = o.assignedTo!.name;
      if (ctx?.watchingSessionIds && !ctx.watchingSessionIds.has(o.assignedTo!.id)) return `Queued → ${name} (not watching)`;
      return `Queued → ${name}`;
    }
    case "open":
      return o.lastHolder ? `Open (last held by ${o.lastHolder.name})` : "Open";
  }
}

export type WriteCheck = { ok: true } | { ok: false; reason: string };

/**
 * May `session` write a reply/state/resolve on this item? Refused when a
 * human pulled the claim from that session, or another session holds a live
 * claim.
 */
export function writeAllowed(o: ItemOverlay, session: SessionRef | null, ctx: LivenessContext): WriteCheck {
  if (session && o.revokedSession === session.id) return { ok: false, reason: "released by the user" };
  if (session && o.assignedTo && o.assignedTo.id !== session.id && ctx.liveSessionIds?.has(o.assignedTo.id))
    return { ok: false, reason: `assigned to ${o.assignedTo.name}` };
  if (session && o.claim && o.claim.session.id !== session.id && claimIsLive(o.claim, ctx))
    return { ok: false, reason: `claimed by ${o.claim.session.name}` };
  return { ok: true };
}

/** An annotation's full thread: the note, the ledger replies, then the resolve note. */
export function annotationThread(a: AnnotationItem): ThreadMessage[] {
  const out: ThreadMessage[] = [{ kind: "human", author: "You", text: a.note.text, ts: a.note.ts }];
  out.push(...a.replies);
  if (a.resolved && a.resolveNote) out.push({ kind: "agent", author: a.resolvedBy ?? "agent", text: a.resolveNote, ts: a.resolvedAt ?? a.lastActivity, state: "resolved" });
  return out;
}

/** An annotation by exact id, or by a unique substring of an OPEN annotation's text. */
export function findAnnotation(state: AnnotationState, idOrText: string): AnnotationItem {
  const exact = state.byId.get(idOrText);
  if (exact) return exact;
  const open = state.items.filter((a) => !a.resolved && !a.withdrawn && a.note.text.includes(idOrText));
  if (open.length === 1) return open[0];
  if (open.length === 0) throw new Error(`no open annotation matches "${idOrText}"`);
  throw new Error(`${open.length} open annotations match "${idOrText}" — use the id (${open.map((m) => m.note.id).join(", ")})`);
}

// ---------------------------------------------------------------------------
// Builders (every write goes through one of these)
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

export function makeNote(text: string, context: ContextStamp | null, client: string, route?: Route): NoteEvent {
  const ev: NoteEvent = { kind: "note", id: annotationId(), ts: now(), client, text, context };
  if (route && route !== "none") ev.route = route;
  return ev;
}
export function makeResolve(target: string, client: string, opts: { note?: string; author?: Author; session?: SessionRef } = {}): ResolveEvent {
  const ev: ResolveEvent = { kind: "resolve", target, ts: now(), client };
  if (opts.note) ev.note = opts.note;
  if (opts.author) ev.author = opts.author;
  if (opts.session) ev.session = opts.session;
  return ev;
}
export function makeWithdraw(target: string, client: string, note?: string): WithdrawEvent {
  const ev: WithdrawEvent = { kind: "withdraw", target, ts: now(), client };
  if (note) ev.note = note;
  return ev;
}
export function makeClaim(target: string, session: SessionRef, client: string, opts: { force?: boolean; takeover?: "stale"; previousClaim?: { id: string; since: string }; previousAssignee?: string } = {}): ClaimEvent {
  const ev: ClaimEvent = { kind: "claim", target, session, ts: now(), client };
  if (opts.force) ev.force = true;
  if (opts.takeover) ev.takeover = opts.takeover;
  if (opts.previousClaim) ev.previousClaim = opts.previousClaim;
  if (opts.previousAssignee) ev.previousAssignee = opts.previousAssignee;
  return ev;
}
export function makeRelease(target: string, by: "agent" | "human", client: string, session?: SessionRef): ReleaseEvent {
  const ev: ReleaseEvent = { kind: "release", target, by, ts: now(), client };
  if (session) ev.session = session;
  return ev;
}
export function makeReply(target: string, author: Author, text: string, client: string, opts: { state?: ReplyEvent["state"]; session?: SessionRef } = {}): ReplyEvent {
  const ev: ReplyEvent = { kind: "reply", target, id: replyId(), author, text, ts: now(), client };
  if (opts.state) ev.state = opts.state;
  if (opts.session) ev.session = opts.session;
  return ev;
}
export function makeState(target: string, state: StateEvent["state"], client: string, session?: SessionRef): StateEvent {
  const ev: StateEvent = { kind: "state", target, state, ts: now(), client };
  if (session) ev.session = session;
  return ev;
}
export function makeReopen(target: string, client: string): ReopenEvent {
  return { kind: "reopen", target, ts: now(), client };
}
export function makeArchive(target: string, archived: boolean, client: string): ArchiveEvent {
  return { kind: archived ? "archive" : "unarchive", target, ts: now(), client };
}
export function makeAssign(target: string, session: SessionRef | null, client: string): AssignEvent {
  return { kind: "assign", target, session, ts: now(), client };
}
export function makeReleaseSession(session: SessionRef, client: string): ReleaseSessionEvent {
  return { kind: "release-session", session, ts: now(), client };
}

// ---------------------------------------------------------------------------
// Human-readable stamp
// ---------------------------------------------------------------------------

/** One line: `figure · fig:fig-2 · plot "density" (fig-2) › series "control" · snapshot ×1 (…)`. */
export function describeStamp(c: ContextStamp | null | undefined): string {
  if (!c) return "";
  const bits: string[] = [c.surface];
  if (c.window?.kind === "utility" && c.window.name) bits.push(`${c.window.name} window`);
  if (c.targets?.length) {
    bits.push(describeTarget(c.targets[0]));
    if (c.targets.length > 1) bits.push(`+${c.targets.length - 1} more`);
  } else {
    if (c.doc?.path) {
      bits.push(c.doc.path);
      if (c.doc.quote) bits.push(`"${c.doc.quote.length > 48 ? c.doc.quote.slice(0, 45) + "…" : c.doc.quote}"`);
    }
    if (c.activeFigureId) bits.push(`fig:${c.activeFigureName ? `"${c.activeFigureName}"` : c.activeFigureId}`);
    if (c.partSelection) bits.push(`part:${c.partSelection.partId}`);
    else if (c.selection?.length) bits.push(`sel:${c.selection.length}`);
    if (c.slide) bits.push(`slide ${c.slide.slideIndex + 1} step ${c.slide.beat}`);
    if (c.present) bits.push(`presenting slide ${c.present.slideIndex + 1} step ${c.present.beat}`);
    if (c.reader?.citekey) bits.push(`${c.reader.citekey}${c.reader.page ? ` p.${c.reader.page}` : ""}${c.reader.selection ? ` "${c.reader.selection.slice(0, 45)}"` : ""}`);
    if (c.library?.selectedKeys?.length) bits.push(`${c.library.selectedKeys.length} reference(s)`);
  }
  if (c.snapshot) bits.push(describeSnapshot(c.snapshot));
  return bits.join(" · ");
}
