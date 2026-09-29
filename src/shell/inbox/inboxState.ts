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
