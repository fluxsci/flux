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

export async function addFeedbackNote(text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const ev = makeNote(body, await captureStamp(), "human");
  // A drawn snapshot lands beside the ledger under the NOTE's id — written
  // before the ledger line, so a note never points at a file that failed.
  const pending = get(pendingSnapshot);
  if (pending && ev.context?.snapshot) {
    let image: string | null = null;
    if (pending.png && root) {
      const fb = fileBridge();
      if (fb) {
        const rel = `${SNAPSHOT_DIR_REL}/${ev.id}.png`;
        await fb.mkdir(joinPath(root, SNAPSHOT_DIR_REL)).catch(() => undefined);
        await fb.writeFile(joinPath(root, rel), pending.png);
        image = rel;
      }
    }
    ev.context = { ...ev.context, snapshot: { ...ev.context.snapshot, image } };
  }
  await append(serializeEvent(ev));
  pendingSnapshot.set(null);
  await refresh(false);
}

export async function sendFeedback(note?: string): Promise<number> {
  const st = get(feedbackState);
  const open = st?.open.length ?? 0;
  await append(serializeEvent(makeSend("human", note)));
  await refresh(false);
  pushToast("info", open ? `Sent — ${open} note(s) are now the agent's work order` : "Sent");
  return open;
}
