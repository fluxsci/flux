// flux-core/feedback.ts — the context-stamped feedback ledger, headless engine.
// The ledger is event-sourced NDJSON at .meta/feedback.ndjson (strictly
// append-only — O_APPEND concurrent-safe against the app appending notes while
// an agent appends resolves). Shapes + fold logic live in the shared pure core
// src/lib/project/feedback.ts (twin-engine rule).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FEEDBACK_REL,
  parseLedger,
  foldLedger,
  makeResolve,
  makeSend,
  findNote,
  describeStamp,
  serializeEvent,
  type FeedbackEvent,
  type FeedbackState,
} from "../src/lib/project/feedback";
import { CLIENT, journal } from "./journal";
import { safeJoin } from "./model";

async function ledgerPath(root: string): Promise<string> {
  return safeJoin(root, FEEDBACK_REL);
}

export async function readFeedbackState(root: string): Promise<FeedbackState> {
  const p = await ledgerPath(root);
  const text = await fs.readFile(p, "utf8").catch(() => "");
  return foldLedger(parseLedger(text));
}

async function appendEvent(root: string, ev: FeedbackEvent): Promise<void> {
  const p = await ledgerPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, serializeEvent(ev)); // O_APPEND — concurrent-safe
}

export interface FeedbackRow {
  id: string;
  ts: string;
  status: "open" | "resolved";
  text: string;
  /** One-line human summary of the context stamp (what the user was looking at). */
  where: string;
  /** The full stamp, for machine consumption. */
  context: unknown;
  resolveNote?: string;
}

/** list feedback notes — open only by default; `all` includes resolved. Also
 *  reports whether a send (review-pass request) is pending. */
export async function listFeedback(
  root: string,
  opts: { all?: boolean } = {},
): Promise<{ notes: FeedbackRow[]; open: number; lastSend: string | null; sentPending: number }> {
  const st = await readFeedbackState(root);
  const src = opts.all ? st.notes : st.open;
  return {
    notes: src.map((n) => ({
      id: n.id,
      ts: n.ts,
      status: n.resolved ? "resolved" : "open",
      text: n.text,
      where: describeStamp(n.context),
      context: n.context,
      ...(n.resolveNote ? { resolveNote: n.resolveNote } : {}),
    })),
    open: st.open.length,
    lastSend: st.lastSend?.ts ?? null,
    sentPending: st.sent.length,
  };
}

/** resolve one note (by id, or a unique substring of its text) with a note on
 *  what was done. Appends a resolve event + journals. */
export async function resolveFeedback(
  root: string,
  idOrText: string,
  opts: { note?: string } = {},
): Promise<{ id: string; text: string; open: number }> {
  const st = await readFeedbackState(root);
  const note = findNote(st, idOrText);
  if (note.resolved) throw new Error(`feedback ${note.id} is already resolved`);
  await appendEvent(root, makeResolve(note.id, CLIENT, opts.note));
  await journal(root, { action: "resolve_feedback", target: note.id });
  return { id: note.id, text: note.text, open: st.open.length - 1 };
}

/** append a send event — "everything open is now a work order" (the review-pass
 *  boundary the attend watcher wakes on). */
export async function sendFeedback(
  root: string,
  opts: { note?: string } = {},
): Promise<{ id: string; open: number }> {
  const st = await readFeedbackState(root);
  const ev = makeSend(CLIENT, opts.note);
  await appendEvent(root, ev);
  await journal(root, { action: "send_feedback", open: st.open.length });
  return { id: ev.id, open: st.open.length };
}

/** GUI-parity helper: append a pre-built event (the renderer builds note events
 *  with live context stamps; the file write rides the same appender). */
export async function appendFeedbackEvent(root: string, ev: FeedbackEvent): Promise<void> {
  await appendEvent(root, ev);
}
