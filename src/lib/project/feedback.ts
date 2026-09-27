// The feedback ledger: context-stamped notes from the human to the agent, plus
// resolution and withdrawal events. Event-sourced NDJSON at .meta/feedback.ndjson — strictly
// append-only, so concurrent writers (app appending notes, agent appending
// resolves) never read-modify-write the same bytes.
// Pure module (no Svelte, no DOM, no Node) — shared by the GUI and flux-core
// (twin-engine rule).

import { describeSnapshot, type FeedbackSnapshot } from "./feedbackCapture";

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
  /** Snapshot & annotate: a crop of the frozen window with numbered, anchored marks. */
  snapshot?: FeedbackSnapshot | null;
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

/** The human took a note back (a stray Enter, a rewrite): it leaves the queue for
 *  good, but the line stays — an agent that already read it sees WHY it is gone. */
export interface FeedbackWithdrawEvent {
  kind: "withdraw";
  /** id of the note being withdrawn */
  target: string;
  ts: string;
  client: string;
  note?: string;
}

export type FeedbackEvent = FeedbackNoteEvent | FeedbackResolveEvent | FeedbackWithdrawEvent;

/** A note with its folded resolution state. */
export interface FeedbackNote extends FeedbackNoteEvent {
  resolved: boolean;
  /** Taken back by the human — never open. */
  withdrawn: boolean;
  withdrawnAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolveNote?: string;
}

export interface FeedbackState {
  notes: FeedbackNote[];
  /** Notes still open (unresolved), oldest first. */
  open: FeedbackNote[];
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
      if (v && (v.kind === "note" || v.kind === "resolve" || v.kind === "withdraw")) out.push(v);
    } catch {
      // tolerate a torn trailing line (crash mid-append); never fail the whole ledger
    }
  }
  return out;
}

export function foldLedger(events: FeedbackEvent[]): FeedbackState {
  const notes: FeedbackNote[] = [];
  const byId = new Map<string, FeedbackNote>();
  events.forEach((ev) => {
    if (ev.kind === "note") {
      const n: FeedbackNote = { ...ev, resolved: false, withdrawn: false };
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
    } else if (ev.kind === "withdraw") {
      const n = byId.get(ev.target);
      if (n) {
        n.withdrawn = true;
        n.withdrawnAt = ev.ts;
      }
    }
  });
  const open = notes.filter((n) => !n.resolved && !n.withdrawn);
  return { notes, open };
}

export function makeNote(text: string, context: FeedbackStamp | null, client: string): FeedbackNoteEvent {
  return { kind: "note", id: feedbackId(), ts: new Date().toISOString(), client, text, context };
}

export function makeResolve(target: string, client: string, note?: string): FeedbackResolveEvent {
  const ev: FeedbackResolveEvent = { kind: "resolve", target, ts: new Date().toISOString(), client };
  if (note) ev.note = note;
  return ev;
}

export function makeWithdraw(target: string, client: string, note?: string): FeedbackWithdrawEvent {
  const ev: FeedbackWithdrawEvent = { kind: "withdraw", target, ts: new Date().toISOString(), client };
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

/** One-line human summary of a stamp, for CLI listings and the popover. */
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
  if (c.snapshot) bits.push(describeSnapshot(c.snapshot));
  return bits.join(" · ");
}
