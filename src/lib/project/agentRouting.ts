// Shared presentation policy for recipients and connected-session work.
import type { Route, SessionRef } from "./annotations";
import type { InboxItem } from "./inbox";
import type { PresenceSession } from "./presence";

export interface RecipientOption {
  key: string;
  route: Route;
  label: string;
  detail: string;
  muted?: boolean;
  live?: boolean;
}

export function orderedSessions(sessions: readonly PresenceSession[]): PresenceSession[] {
  return [...sessions].sort((a, b) => Number(b.watching) - Number(a.watching) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function recipientOptions(sessions: readonly PresenceSession[], backgroundAvailable = false): RecipientOption[] {
  return [
    { key: "none", route: "none", label: "Inbox", detail: "Nobody acts until you ask" },
    { key: "any", route: "any", label: "Any watching agent", detail: "First to claim takes it" },
    ...orderedSessions(sessions).map(s => ({
      key: s.id, route: { session: { id: s.id, name: s.name, client: s.client } }, label: s.name,
      detail: s.watching ? s.display : "queued until it watches", muted: !s.watching, live: s.live,
    })),
    ...(backgroundAvailable ? [{ key: "background", route: { background: "claude" as const }, label: "New background agent", detail: "Start a fresh agent for this item" }] : []),
  ];
}

export function sessionWork(items: readonly InboxItem[], id: string): { queued: InboxItem[]; claims: InboxItem[] } {
  const open = items.filter(i => !i.archived && i.status !== "resolved" && i.status !== "withdrawn");
  return {
    queued: open.filter(i => i.assignedTo?.id === id && !i.claimedBy),
    claims: open.filter(i => i.claimedBy?.id === id),
  };
}

/** The existing @holder query, with no leftover filters to hide this agent's work. */
export function sessionInboxQuery(session: SessionRef): string { return `@${session.name}`; }

export function visibleSessions(sessions: readonly PresenceSession[], stopped: ReadonlyMap<string, string>): PresenceSession[] {
  return orderedSessions(sessions.map(s => stopped.has(s.id) ? { ...s, watching: false } : s));
}
