// Shell-level feedback-ledger state (principal-agent scheme): reads/folds the
// project's .meta/feedback.ndjson, appends context-stamped notes and send
// events, and toasts when an agent resolves notes externally (the watcher's
// feedbackRevision bump). Slide state is dynamically imported at capture time
// so the slide module never enters the eager startup bundle.

import { get, writable } from "svelte/store";
import { fileBridge, joinPath } from "../../lib/project/types";
import {
  FEEDBACK_REL,
  foldLedger,
  makeNote,
  makeSend,
  makeWithdraw,
  type FeedbackNote,
  parseLedger,
  serializeEvent,
  type FeedbackStamp,
  type FeedbackState,
} from "../../lib/project/feedback";
import { SNAPSHOT_DIR_REL, type FeedbackSnapshot } from "../../lib/project/feedbackCapture";
import { paperSelection } from "../../lib/project/paperSelectionStore";
import { feedbackRevision } from "../../lib/project/projectWatch";
import { getAppContext } from "../../lib/bridge/appContext";
import { pushToast } from "../../lib/toast";
import { currentProject } from "../shellStore";
import { focusedMode } from "../paneStore";

export const feedbackState = writable<FeedbackState | null>(null);

/** A snapshot drawn but not yet attached to a note (Snapshot & annotate → Add).
 *  The PNG bytes stay in memory until Add writes them beside the ledger, so a
 *  cancelled note never leaves a stray file behind. */
export interface PendingSnapshot {
  info: FeedbackSnapshot;
  png: Uint8Array | null;
  /** Small data-URL thumbnail for the popover chip (null in a browser build). */
  preview: string | null;
}
export const pendingSnapshot = writable<PendingSnapshot | null>(null);
export function setPendingSnapshot(s: PendingSnapshot | null): void {
  pendingSnapshot.set(s);
}
export function clearPendingSnapshot(): void {
  pendingSnapshot.set(null);
}

let root: string | null = null;
let seenResolved = new Set<string>();
let wired = false;

async function refresh(toastNew: boolean): Promise<void> {
  if (!root) {
    feedbackState.set(null);
    return;
  }
  const fb = fileBridge();
  if (!fb) return;
  let text = "";
  try {
    text = await fb.readText(joinPath(root, FEEDBACK_REL));
  } catch {
    /* no ledger yet */
  }
  const st = foldLedger(parseLedger(text));
  const resolved = new Set(st.notes.filter((n) => n.resolved).map((n) => n.id));
  if (toastNew) {
    const fresh = st.notes.filter((n) => n.resolved && !seenResolved.has(n.id));
    for (const n of fresh.slice(0, 3)) {
      const label = n.text.length > 60 ? n.text.slice(0, 57) + "…" : n.text;
      pushToast("success", `Agent resolved: ${label}`, n.resolveNote ? { detail: n.resolveNote } : undefined);
    }
    if (fresh.length > 3) pushToast("success", `…and ${fresh.length - 3} more feedback notes resolved`);
  }
  seenResolved = resolved;
  feedbackState.set(st);
}

/** Wire the store to the open project + external-change revisions (idempotent;
 *  called once from the Workspace mount). */
export function initFeedbackStore(): void {
  if (wired) return;
  wired = true;
  currentProject.subscribe((p) => {
    root = p?.path ?? null;
    seenResolved = new Set();
    void refresh(false);
  });
  let seenRev = get(feedbackRevision);
  feedbackRevision.subscribe((n) => {
    if (n === seenRev) return;
    seenRev = n;
    void refresh(true);
  });
}

/** Build the context stamp for a note captured RIGHT NOW. */
export async function captureStamp(): Promise<FeedbackStamp> {
  const surface = get(focusedMode);
  const app = getAppContext();
  const stamp: FeedbackStamp = {
    surface,
    activeFigureId: app.activeFigureId,
    selection: app.selection,
    partSelection: app.partSelection,
    viewport: app.viewport,
    doc: null,
    slide: null,
    snapshot: get(pendingSnapshot)?.info ?? null,
  };
  if (surface === "paper") {
    const ps = get(paperSelection);
    if (ps) stamp.doc = { path: ps.doc, from: ps.from, to: ps.to, quote: ps.quote };
    // Figure fields are meaningless while writing — drop the noise.
    stamp.activeFigureId = null;
    stamp.selection = [];
    stamp.partSelection = null;
    stamp.viewport = null;
  } else if (surface === "slide") {
    try {
      const slide = await import("../../lib/slide/store");
      const deck = get(slide.deckOverlay);
      if (deck) {
        const idx = deck.slides.findIndex((s: { id: string }) => s.id === app.activeFigureId);
        stamp.slide = {
          deckId: deck.id,
          slideIndex: idx >= 0 ? idx : 0,
          beat: get(slide.activeBeat),
        };
      }
    } catch {
      /* slide module unavailable — stamp stays figure-shaped */
    }
  }
  return stamp;
}

async function append(line: string): Promise<void> {
  const fb = fileBridge();
  if (!root || !fb?.feedbackAppend) throw new Error("feedback needs an open project");
  await fb.feedbackAppend(joinPath(root, FEEDBACK_REL), line);
}

/** Add a note to the queue. `replaces` re-queues an edited note: the original is
 *  withdrawn in the SAME append (one O_APPEND write, so a reader never sees the
 *  note twice), and `context` keeps the stamp the original was written with —
 *  an edit is about the same thing, not about whatever is selected now. */
export async function addFeedbackNote(
  text: string,
  opts: { replaces?: string; context?: FeedbackStamp | null } = {},
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const stamp: FeedbackStamp | null = opts.context ? { ...opts.context } : await captureStamp();
  const ev = makeNote(body, stamp, "human");
  // The attached snapshot: a freshly drawn one lands beside the ledger under the
  // NOTE's id — written before the ledger line, so a note never points at a
  // file that failed; a re-attached one (Edit) keeps pointing at its file.
  const pending = get(pendingSnapshot);
  if (ev.context) {
    let snapshot = pending ? { ...pending.info } : null;
    if (pending && pending.png && root) {
      const fb = fileBridge();
      if (fb) {
        const rel = `${SNAPSHOT_DIR_REL}/${ev.id}.png`;
        await fb.mkdir(joinPath(root, SNAPSHOT_DIR_REL)).catch(() => undefined);
        await fb.writeFile(joinPath(root, rel), pending.png);
        snapshot = { ...pending.info, image: rel };
      }
    }
    ev.context = { ...ev.context, snapshot };
  }
  const lines = (opts.replaces ? serializeEvent(makeWithdraw(opts.replaces, "human", "edited")) : "") + serializeEvent(ev);
  await append(lines);
  pendingSnapshot.set(null);
  await refresh(false);
}

/** Take a queued note back: an append-only withdraw line — the note leaves the
 *  queue (and any work order) for good; an agent that already listed it sees why. */
export async function withdrawFeedbackNote(id: string): Promise<void> {
  await append(serializeEvent(makeWithdraw(id, "human")));
  await refresh(false);
  pushToast("info", "Note withdrawn");
}

/** For Edit: put a queued note's snapshot back on the popover (preview read from
 *  its PNG when the build can read files; the file itself is reused, not copied). */
export async function snapshotOfNote(note: FeedbackNote): Promise<PendingSnapshot | null> {
  const snap = note.context?.snapshot;
  if (!snap) return null;
  let preview: string | null = null;
  const fb = fileBridge();
  if (snap.image && root && fb) {
    try {
      const bytes = new Uint8Array(await fb.readFile(joinPath(root, snap.image)));
      const copy = new Uint8Array(bytes.byteLength); // a plain ArrayBuffer-backed copy for Blob
      copy.set(bytes);
      preview = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(new Blob([copy], { type: "image/png" }));
      });
    } catch {
      preview = null; // the file is gone or unreadable — the marks still carry the anchors
    }
  }
  return { info: { ...snap, marks: snap.marks.map((m) => ({ ...m })) }, png: null, preview };
}

export async function sendFeedback(note?: string): Promise<number> {
  const st = get(feedbackState);
  const open = st?.open.length ?? 0;
  await append(serializeEvent(makeSend("human", note)));
  await refresh(false);
  pushToast("info", open ? `Sent — ${open} note(s) are now the agent's work order` : "Sent");
  return open;
}
