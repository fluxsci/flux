// Lightweight shell entry: the model, IO and view load only after startup.
import { derived, get, writable } from "svelte/store";
import { setShellPanel } from "../agent/annotationVisibility";
import { currentProject } from "../shellStore";
import { pushToast } from "../../lib/toast";
import type { SessionRef } from "../../lib/project/annotations";

export const inboxOpen = writable(false);
export const inboxDetached = writable(false);
// The docked Inbox owns the keyboard like a modal (a pinned window does not).
derived([inboxOpen, inboxDetached], ([open, detached]) => open && !detached).subscribe(v => setShellPanel("inbox", v));
export const inboxCloseRequest = writable(0);
export const inboxFocusRequest = writable(0);
export const inboxCount = writable(0);
/** Items waiting on the human (an agent asked a question) — the badge turns gold. */
export const inboxNeedsInput = writable(0);
/** The connected agents holding a claim right now, by name: each one lights a point of the Flux AI mark. */
export const inboxAgentsAtWork = writable<string[]>([]);
/** True for a moment after an agent resolves what it had claimed: the mark's green lap. */
export const inboxJustFinished = writable(false);
/** What the Flux AI mark's colour says, everywhere it reports the Inbox (its header, the title
 *  bar): gold while something waits for you, green for a moment when an agent finishes, blue
 *  while an agent works, the bloom's own colours otherwise. */
export const fluxAiTone = derived([inboxNeedsInput, inboxAgentsAtWork, inboxJustFinished], ([needs, agents, finished]) =>
  (needs > 0 ? "wait" : finished ? "done" : agents.length ? "live" : "ready") as "wait" | "done" | "live" | "ready");
export const inboxSelection = writable<string | null>(null);
export const inboxQuery = writable("");
export const inboxDrafts = new Map<string, string>();
export function requestInbox(id?: string): void {
  if (!get(currentProject)?.path) { pushToast("info", "Open a project to use Inbox"); return; }
  if (id) { inboxSelection.set(id); inboxQuery.set(""); }
  inboxOpen.set(true);
  inboxFocusRequest.update(n => n + 1);
}
export function isInboxChord(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyQ";
}
export async function requestSessionInbox(session: SessionRef): Promise<void> {
  const owner = get(currentProject)?.path;
  if (!owner) return;
  const { sessionInboxQuery } = await import("../../lib/project/agentRouting");
  if (owner !== get(currentProject)?.path) return;
  inboxSelection.set(null);
  inboxQuery.set(sessionInboxQuery(session));
  requestInbox();
}
