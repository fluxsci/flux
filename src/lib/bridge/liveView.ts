// Transient, project-scoped activity for the titlebar and AI panel. No polling.
import { readonly, writable } from "svelte/store";
import { fileBridge, joinPath } from "../project/types";
import { isPresenceStale, parsePresence, presenceFileRel } from "../project/presence";

export interface LiveViewEvent { root: string; client: string; sessionId?: string; at: string }
export interface AgentViewActivity extends LiveViewEvent { action: "live_view"; name: string }

export function createLiveViewActivity(resolveName: (event: LiveViewEvent) => Promise<string | null>) {
  const recent = writable<AgentViewActivity[]>([]), indicator = writable<AgentViewActivity | null>(null);
  let root: string | null = null, generation = 0, sequence = 0, shown = 0;
  let rows: { sequence: number; event: AgentViewActivity }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    recent: readonly(recent), indicator: readonly(indicator),
    setRoot(next: string | null) {
      if (next === root) return;
      root = next; generation++; rows = []; recent.set([]); indicator.set(null);
      clearTimeout(timer);
    },
    async record(event: LiveViewEvent) {
      if (event.root !== root) return;
      const owner = generation, order = ++sequence;
      const name = await resolveName(event).catch(() => null) || event.client;
      if (owner !== generation) return;
      const activity: AgentViewActivity = { ...event, action: "live_view", name };
      rows = [...rows, { sequence: order, event: activity }].sort((a, b) => b.sequence - a.sequence).slice(0, 20);
      recent.set(rows.map(r => r.event));
      if (order < shown) return;
      shown = order;
      indicator.set(activity);
      clearTimeout(timer);
      timer = setTimeout(() => indicator.set(null), 2000);
    },
  };
}

export const liveViewActivity = createLiveViewActivity(async event => {
  if (!event.sessionId) return null;
  const text = await fileBridge()?.readText(joinPath(event.root, presenceFileRel(event.sessionId)));
  const session = text ? parsePresence(text) : null;
  return session?.id === event.sessionId && !isPresenceStale(session, Date.now()) ? session.name : null;
});
/** The AI panel can render these under "Recent agent activity". Newest first, max 20. */
export const recentAgentActivity = liveViewActivity.recent;
export const lastAgentView = liveViewActivity.indicator;
