import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { deliverableTo, type InboxItem, type WatchSpec } from "../src/lib/project/inbox";
import { ANNOTATIONS_REL } from "../src/lib/project/annotations";
import { PRESENCE_DIR_REL } from "../src/lib/project/presence";
import { inboxSession, readInbox, prepareInboxFilter, type InboxCaller, type ListInboxOptions, type InboxSnapshot } from "./annotations";
import { ValidationError } from "./errors";

interface Cursor { v: 1; root: string; items: Record<string, string>; revoked: Record<string, string> }
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
const cursors = new Map<string, string>();
function decode(token: string | undefined, root: string): Cursor {
  if (!token) return { v: 1, root, items: {}, revoked: {} };
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (value.v !== 1 || value.root !== root || !value.items || typeof value.items !== "object" || !value.revoked || typeof value.revoked !== "object") throw new Error();
    return value;
  } catch { throw new ValidationError("invalid inbox cursor for this project"); }
}
function cursorFor(snapshot: InboxSnapshot, root: string, sessionId: string): Cursor {
  const revoked: Record<string, string> = {};
  for (const o of [...snapshot.state.items, ...snapshot.state.overlays.values()]) {
    if (o.revokedSession === sessionId) revoked[o.id] = hash([o.lastActivity, o.revokedSession]);
  }
  return { v: 1, root, items: Object.fromEntries(snapshot.items.map(item => [item.id, hash(item)])), revoked };
}
export interface WaitInboxOptions extends ListInboxOptions {
  timeoutMs?: number;
  cursor?: string;
  mode?: WatchSpec["mode"];
  signal?: AbortSignal;
  /** Presence lifecycle is supplied by the MCP server; CLI has no writer. */
  watching?: (pending: boolean, watch: WatchSpec) => Promise<void>;
  /** Test/process barrier: listeners are attached and the initial read completed. */
  onReady?: () => void;
}
export interface WaitInboxResult {
  items: InboxItem[];
  cursor: string;
  stopped: boolean;
  revoked: { id: string; reason: "released by the user" }[];
}

export async function waitForInbox(root: string, opts: WaitInboxOptions = {}, caller: InboxCaller = {}): Promise<WaitInboxResult> {
  const session = inboxSession(caller), rootKey = hash(path.resolve(root));
  const key = JSON.stringify([rootKey, session.id, opts.filter, opts.query, opts.mine, opts.mode]);
  const previous = decode(opts.cursor ?? cursors.get(key), rootKey);
  const configured = Number(process.env.FLUX_WAIT_MAX_MS ?? 600_000);
  const timeout = opts.timeoutMs ?? configured;
  if (!Number.isFinite(timeout) || timeout < 0) throw new ValidationError("timeoutMs must be a non-negative number");
  const deadline = Date.now() + timeout;
  const watchers = new Map<string, FSWatcher>();
  let wake: (() => void) | undefined, dirty = true, closed = false, signature = "";
  const changed = () => { dirty = true; wake?.(); };
  const addWatch = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(dir, changed);
      watcher.on("error", () => { watcher.close(); watchers.delete(dir); changed(); });
      watchers.set(dir, watcher);
    } catch (e) {
      if (!["ENOENT", "ENOSPC", "ENOSYS", "ENOTSUP", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  };
  const wakeOnAbort = () => changed();
  opts.signal?.addEventListener("abort", wakeOnAbort);
  let last: WaitInboxResult = { items: [], cursor: Buffer.from(JSON.stringify(previous)).toString("base64url"), stopped: false, revoked: [] };
  let watchSpec: WatchSpec = { mode: opts.mode ?? "annotations" } as WatchSpec;
  const finish = (result: WaitInboxResult) => {
    cursors.set(key, result.cursor);
    if (cursors.size > 256) cursors.delete(cursors.keys().next().value!);
    return result;
  };
  // Poll all watched directories as well as file mtimes. New documents and
  // atomic sidecar replacements remain observable when native events are lost.
  async function mtimeSignature() {
    const names = new Set([path.join(root, ANNOTATIONS_REL), path.join(root, "project.json")]);
    for (const dir of watchers.keys()) {
      names.add(dir);
      try { for (const n of await fs.readdir(dir)) if (n.endsWith(".json") || n.endsWith(".qmd") || n.endsWith(".md")) names.add(path.join(dir, n)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return (await Promise.all([...names].sort().map(async file => {
      try { const s = await fs.stat(file); return `${file}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return `${file}:missing`; throw e; }
    }))).join("\n");
  }
  const poll = setInterval(changed, 1000);
  try {
    addWatch(root); addWatch(path.join(root, ".meta"));
    let ready = false, lastRead = 0;
    for (;;) {
      if (opts.signal?.aborted) return finish({ ...last, items: [], stopped: true });
      try { await fs.access(path.join(root, "project.json")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return finish({ ...last, items: [], stopped: true }); throw e; }
      dirty = false;
      const nextSignature = await mtimeSignature();
      // Presence and claim TTLs can expire without a filesystem event.
      if (!ready || nextSignature !== signature || Date.now() - lastRead >= 1000) {
        signature = nextSignature; lastRead = Date.now();
        const snapshot = await readInbox(root);
        const { filter, context } = await prepareInboxFilter(root, snapshot, opts, caller);
        watchSpec = opts.mode === "queue" ? { mode: "queue" } : { mode: opts.mode ?? "annotations", filter };
        if (!ready) await opts.watching?.(true, watchSpec);
        addWatch(path.join(root, ".meta")); addWatch(path.join(root, PRESENCE_DIR_REL));
        for (const doc of snapshot.documents) addWatch(path.dirname(path.join(root, doc.path)));
        const cursor = cursorFor(snapshot, rootKey, session.id);
        const revoked = Object.entries(cursor.revoked).filter(([id, version]) => previous.revoked[id] !== version).map(([id]) => ({ id, reason: "released by the user" as const }));
        const items = snapshot.items.filter(item => deliverableTo(item, session, watchSpec, context) && (previous.items[item.id] !== cursor.items[item.id] || item.assignedTo?.id === session.id));
        last = { items, cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"), stopped: snapshot.state.stoppedSessions.has(session.id), revoked };
        if (!ready) { ready = true; opts.onReady?.(); }
        if (last.stopped) return finish({ ...last, items: [] });
        if (items.length || revoked.length) return finish(last);
      }
      if (Date.now() >= deadline) return finish({ ...last, items: [] });
      if (dirty) continue;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(1000, Math.max(0, deadline - Date.now())));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        if (dirty || closed || opts.signal?.aborted) wake();
      });
    }
  } finally {
    closed = true; clearInterval(poll); opts.signal?.removeEventListener("abort", wakeOnAbort);
    for (const watcher of watchers.values()) watcher.close();
    await opts.watching?.(false, watchSpec);
  }
}
