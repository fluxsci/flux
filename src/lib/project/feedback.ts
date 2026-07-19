// The feedback ledger: context-stamped notes from the human to the agent, plus
// send/resolve events. Event-sourced NDJSON at .meta/feedback.ndjson — strictly
// append-only, so concurrent writers (app appending notes, agent appending
// resolves) never read-modify-write the same bytes.
// Pure module (no Svelte, no DOM, no Node) — shared by the GUI, flux-core, and
// the attend watcher (twin-engine rule).

export const FEEDBACK_REL = ".meta/feedback.ndjson";

/** What the user was looking at when they wrote the note. */
export interface FeedbackStamp {
  /** Focused mode at capture time ("figure" | "paper" | "slide" | ...). */
  surface: string;
  activeFigureId?: string | null;
  selection?: string[];
  /** Drilled-in plot part (element + semantic part id), figure/slide modes. */
  partSelection?: { elementId: string; partId: string } | null;
  /** Paper mode: the active document + selection range and quoted text. */
  doc?: { path: string; from: number; to: number; quote: string } | null;
  /** Slide mode: which slide/beat the user was on. */
  slide?: { deckId: string; slideIndex: number; beat: number } | null;
  viewport?: { panX: number; panY: number; zoom: number } | null;
}

export interface FeedbackNoteEvent {
  kind: "note";
  id: string;
  ts: string;
  client: string;
  text: string;
  context: FeedbackStamp | null;
}

export interface FeedbackResolveEvent {
  kind: "resolve";
  /** id of the note being resolved */
  target: string;
  ts: string;
  client: string;
  note?: string;
}

/** A send marks a review-pass boundary: "everything open is now a work order." */
export interface FeedbackSendEvent {
  kind: "send";
  id: string;
  ts: string;
  client: string;
  note?: string;
}

export type FeedbackEvent = FeedbackNoteEvent | FeedbackResolveEvent | FeedbackSendEvent;

/** A note with its folded resolution state. */
export interface FeedbackNote extends FeedbackNoteEvent {
  resolved: boolean;
  /** Position in the ledger — the event ORDER is authoritative (timestamps tie
   *  within a millisecond; the send boundary must never capture later notes). */
  seq: number;
  resolvedAt?: string;
  resolvedBy?: string;
  resolveNote?: string;
}

export interface FeedbackState {
  notes: FeedbackNote[];
  /** Most recent send event, if any. */
  lastSend: FeedbackSendEvent | null;
  /** Notes still open (unresolved), oldest first. */
  open: FeedbackNote[];
  /** Open notes created at-or-before the last send (the current work order). */
  sent: FeedbackNote[];
}

export function feedbackId(): string {
  return "fb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function serializeEvent(ev: FeedbackEvent): string {
  return JSON.stringify(ev) + "\n";
}

export function parseLedger(text: string): FeedbackEvent[] {
  const out: FeedbackEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && (v.kind === "note" || v.kind === "resolve" || v.kind === "send")) out.push(v);
    } catch {
      // tolerate a torn trailing line (crash mid-append); never fail the whole ledger
    }
  }
  return out;
}

export function foldLedger(events: FeedbackEvent[]): FeedbackState {
  const notes: FeedbackNote[] = [];
  const byId = new Map<string, FeedbackNote>();
  let lastSend: FeedbackSendEvent | null = null;
  let lastSendSeq = -1;
  events.forEach((ev, seq) => {
    if (ev.kind === "note") {
      const n: FeedbackNote = { ...ev, resolved: false, seq };
      notes.push(n);
      byId.set(n.id, n);
    } else if (ev.kind === "resolve") {
      const n = byId.get(ev.target);
      if (n) {
        n.resolved = true;
        n.resolvedAt = ev.ts;
        n.resolvedBy = ev.client;
        if (ev.note) n.resolveNote = ev.note;
      }
    } else if (ev.kind === "send") {
      lastSend = ev;
      lastSendSeq = seq;
    }
  });
  const open = notes.filter((n) => !n.resolved);
  const sent = lastSend ? open.filter((n) => n.seq < lastSendSeq) : [];
  return { notes, lastSend, open, sent };
}

export function makeNote(text: string, context: FeedbackStamp | null, client: string): FeedbackNoteEvent {
  return { kind: "note", id: feedbackId(), ts: new Date().toISOString(), client, text, context };
}

export function makeResolve(target: string, client: string, note?: string): FeedbackResolveEvent {
  const ev: FeedbackResolveEvent = { kind: "resolve", target, ts: new Date().toISOString(), client };
  if (note) ev.note = note;
  return ev;
}

export function makeSend(client: string, note?: string): FeedbackSendEvent {
  const ev: FeedbackSendEvent = { kind: "send", id: feedbackId(), ts: new Date().toISOString(), client };
  if (note) ev.note = note;
  return ev;
}

/**
 * Resolve a note by id, or by a unique substring of its text (mirrors
 * resolve-comment's id-or-quote ergonomics). Throws when 0 or >1 open notes match.
 */
export function findNote(state: FeedbackState, idOrText: string): FeedbackNote {
  const exact = state.notes.find((n) => n.id === idOrText);
  if (exact) return exact;
  const matches = state.open.filter((n) => n.text.includes(idOrText));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no open feedback note matches "${idOrText}"`);
  throw new Error(
    `${matches.length} open notes match "${idOrText}" — use the id (${matches.map((m) => m.id).join(", ")})`
  );
}

/** One-line human summary of a stamp, for CLI listings and the drawer. */
export function describeStamp(c: FeedbackStamp | null | undefined): string {
  if (!c) return "";
  const bits: string[] = [c.surface];
  if (c.doc?.path) {
    bits.push(c.doc.path);
    if (c.doc.quote) bits.push(`"${c.doc.quote.length > 48 ? c.doc.quote.slice(0, 45) + "…" : c.doc.quote}"`);
  }
  if (c.activeFigureId) bits.push(`fig:${c.activeFigureId}`);
  if (c.partSelection) bits.push(`part:${c.partSelection.partId}`);
  else if (c.selection?.length) bits.push(`sel:${c.selection.length}`);
  if (c.slide) bits.push(`slide ${c.slide.slideIndex + 1} beat ${c.slide.beat}`);
  return bits.join(" · ");
}
