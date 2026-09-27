// The MCP-owned writer; session shape/names/staleness live in the pure core.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  presenceName, presenceFileRel, PRESENCE_HEARTBEAT_MS, type PresenceSession,
} from "../src/lib/project/presence";
import type { WatchSpec } from "../src/lib/project/inbox";
import type { AgentIdentity } from "./agentIdentity";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { confinedInboxPath, readAnnotationEvents, readAnnotationState, readOptional } from "./annotations";
import { foldAnnotations } from "../src/lib/project/annotations";

export async function createPresenceWriter(root: string, id: string, identity: AgentIdentity, clientVersion?: string, live = false) {
  const file = await confinedInboxPath(root, presenceFileRel(id));
  let session: PresenceSession;
  await withLock(root, "presence", identity.client, async () => {
    const { presence } = await readAnnotationState(root);
    const taken = new Set([...presence.values()].filter(s => s.id !== id).map(s => s.name));
    const product = identity.product ?? "agent", surface = identity.surface ?? "MCP";
    const names = presenceName({ id, product, surface }, taken);
    const now = new Date().toISOString();
    session = { v: 1, id, ...names, product, surface, client: identity.client, clientVersion,
      pid: process.pid, host: os.hostname(), startedAt: now, heartbeatAt: now, watching: false, live };
    await atomicWrite(file, JSON.stringify(session) + "\n");
  });
  let stopped = false, pending = 0, watchingUntil = 0, tail = Promise.resolve();
  let latest: WatchSpec | undefined;
  const controller = new AbortController();
  function publish() {
    tail = tail.catch(() => {}).then(async () => {
      if (stopped) return;
      // Stop watching (release-session) ends watching now, not after the grace period. A ledger
      // read failure must never stop the heartbeat itself: the session would look gone.
      const released = await readAnnotationEvents(root).then(events => foldAnnotations(events).stoppedSessions.has(id), () => false);
      session = { ...session, heartbeatAt: new Date().toISOString(), watching: !released && (pending > 0 || Date.now() < watchingUntil),
        ...(latest ? { watchMode: latest.mode, filter: "filter" in latest ? latest.filter as Record<string, unknown> : undefined } : {}) };
      await atomicWrite(file, JSON.stringify(session) + "\n");
    });
    return tail;
  }
  let heartbeatPending = false;
  const timer = setInterval(() => {
    if (heartbeatPending || stopped) return;
    heartbeatPending = true;
    void publish().catch(e => { console.error(`Flux presence heartbeat: ${(e as Error).message}`); }).finally(() => { heartbeatPending = false; });
  }, PRESENCE_HEARTBEAT_MS);
  timer.unref();
  return {
    root, signal: controller.signal,
    currentSession: () => ({ ...session }),
    async watching(active: boolean, spec: WatchSpec) {
      latest = spec;
      pending = Math.max(0, pending + (active ? 1 : -1));
      if (!active) watchingUntil = Date.now() + 120_000;
      await publish();
    },
    async close() {
      if (stopped) return;
      stopped = true; controller.abort(); clearInterval(timer);
      await tail.catch(() => {});
      const text = await readOptional(file);
      if (text) {
        const current = JSON.parse(text);
        if (current.pid === session.pid && current.startedAt === session.startedAt) await fs.rm(file, { force: true });
      }
    },
  };
}
