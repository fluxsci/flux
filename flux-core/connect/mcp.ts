// flux-connect over MCP: the session's delta cursor, the piggyback notice on
// every tool result (plan §8.8 Delivery 1), and the pack-reading tools
// (read_pack, get_pack_image, read_delta). Kept out of mcpServer.ts so the
// server stays a thin registration list.

import { z } from "zod";
import type { McpRender } from "../registry";
import { computeDelta, changedPaths, renderDeltaDetails, renderDeltaLine, sameSnapshot, takeSnapshot, type DeltaCursor, type StatSnapshot } from "./refresh";
import { deltaInputs, packImage, readPack } from "./index";
import { renderCanvasPng } from "../render";
import { readFigIndex } from "../model";
import type { AgentIdentity } from "../agentIdentity";

/** What the registry's connect verb tells the server after it connected. */
export interface ConnectedInfo {
  root: string | null;
  title: string;
  packId: string;
  cursor: DeltaCursor | null;
  live: boolean;
}

/** Hooks a registry verb can reach through VerbCtx.mcp. */
export interface McpSessionHooks {
  /** This session's presence name, once connected (null before, or without presence). */
  name(): string | null;
  /** Start (or keep) this session's presence on a project before the brief is written, so the
   *  brief and its receipt can carry the session's name. */
  bind?(root: string, live: boolean): Promise<{ id: string; name: string } | null>;
  connected(info: ConnectedInfo): void;
}

/** Tools that never carry the notice: they ARE the reading path. */
const QUIET = new Set(["connect", "read_delta", "read_pack", "get_pack_image", "flux_verbs", "connect_doctor"]);
/** Canvases re-rendered into a read_delta result when figures changed. */
const DELTA_IMAGES = 3;

export interface ConnectSession {
  hooks: McpSessionHooks;
  /** The connected project root (null: not connected, or global). */
  root(): string | null;
  /** Run a tool body with the before/after snapshots and append the notice when something external changed. */
  wrap(name: string, run: () => Promise<McpRender>): Promise<McpRender>;
  tools(): ConnectTool[];
}

export interface ConnectTool {
  name: string;
  meta: { description: string; inputSchema: z.ZodRawShape; scope: "machine"; core: true };
  fn: (args: Record<string, unknown>) => Promise<McpRender>;
}

export function createConnectSession(opts: {
  identity: () => AgentIdentity;
  name?: () => string | null;
  bind?: (root: string, live: boolean) => Promise<{ id: string; name: string } | null>;
}): ConnectSession {
  let state: { cursor: DeltaCursor; notified: StatSnapshot; texts: Map<string, string>; title: string } | null = null;
  let connectedRoot: string | null = null;

  const ok = (text: string): McpRender => ({ content: [{ type: "text", text }] });
  const textOf = (texts: Map<string, string>, base: DeltaCursor["text"]) => async (sha: string) => texts.get(sha) ?? base(sha);

  return {
    hooks: {
      name: () => opts.name?.() ?? null,
      ...(opts.bind ? { bind: opts.bind } : {}),
      connected(info) {
        // A global connect keeps the project binding (plan §8.7), so it keeps the project's cursor too.
        if (!info.root && state) return;
        connectedRoot = info.root;
        state = info.cursor ? { cursor: info.cursor, notified: info.cursor.snapshot, texts: new Map(), title: info.title } : null;
      },
    },
    root: () => connectedRoot,
    async wrap(name, run) {
      if (!state || QUIET.has(name)) return run();
      const s = state;
      const before = await takeSnapshot(s.cursor.snapshot.paths);
      const result = await run();
      if (state !== s) return result; // the tool reconnected
      const after = await takeSnapshot(s.cursor.snapshot.paths);
      const external = !sameSnapshot(before, s.notified);
      try {
        if (external) {
          // Something moved that this session did not do: say so, keep the cursor (read_delta reads it).
          const changed = changedPaths(s.cursor.snapshot, after);
          if (changed.length) {
            const cursor = { ...s.cursor, text: textOf(s.texts, s.cursor.text) };
            const delta = await computeDelta(deltaInputs(s.cursor.root, cursor, changed, opts.identity().sessionId));
            if (delta.changes.length) result.content = [...result.content, { type: "text", text: renderDeltaLine(delta, s.cursor.since) }];
          }
          s.notified = after;
        } else if (!sameSnapshot(before, after)) {
          // Only this call's own writes: absorb them so they are never reported back as news.
          const cursor = { ...s.cursor, text: textOf(s.texts, s.cursor.text) };
          const delta = await computeDelta(deltaInputs(s.cursor.root, cursor, changedPaths(s.cursor.snapshot, after), opts.identity().sessionId));
          for (const [sha, t] of delta.texts) s.texts.set(sha, t);
          s.cursor = { ...s.cursor, state: delta.state, snapshot: after };
          s.notified = after;
        }
      } catch {
        /* the notice is advisory; never fail the tool over it */
      }
      return result;
    },
    tools(): ConnectTool[] {
      const tools: ConnectTool[] = [
        {
          name: "read_pack",
          meta: {
            scope: "machine",
            core: true,
            description:
              "Read a flux-connect pack without file permissions: section 'brief', one bundle section ('A'…'K'), or the bundle in sequential ≤20k-character parts (part 1, 2, …). Refuses a pack that is not on this machine.",
            inputSchema: { packId: z.string(), section: z.string().optional(), part: z.number().int().positive().optional() },
          },
          fn: async (a) => {
            const r = await readPack(String(a.packId), { section: a.section as string | undefined, part: a.part as number | undefined });
            return ok(r.text);
          },
        },
        {
          name: "get_pack_image",
          meta: {
            scope: "machine",
            core: true,
            description: "Look at image `index` (from 0) of a flux-connect pack, as an image. Each carries a proof code in its bottom-right corner for your receipt.",
            inputSchema: { packId: z.string(), index: z.number().int().nonnegative() },
          },
          fn: async (a) => {
            const r = await packImage(String(a.packId), Number(a.index));
            return { content: [{ type: "image", data: r.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `Image ${a.index} of ${r.count}: ${r.label}` }] };
          },
        },
        {
          name: "read_delta",
          meta: {
            scope: "machine",
            core: true,
            description:
              "What changed in the connected project since you last looked: edited Context files and documents (with the changed lines), new Log entries in full, figure changes (with fresh canvas images), and new or closed inbox items. Advances your cursor.",
            inputSchema: {},
          },
          fn: async () => {
            if (!state) return ok(connectedRoot === null ? "Not connected to a project. Call connect first (only when the user asks for flux-connect)." : "Nothing to compare: this session connected without a pack.");
            const s = state;
            const now = await takeSnapshot(s.cursor.snapshot.paths);
            const changed = changedPaths(s.cursor.snapshot, now);
            const content: McpRender["content"] = [];
            if (!changed.length) content.push({ type: "text", text: "Nothing changed since you last looked." });
            else {
              const cursor = { ...s.cursor, text: textOf(s.texts, s.cursor.text) };
              const delta = await computeDelta(deltaInputs(s.cursor.root, cursor, changed, opts.identity().sessionId));
              for (const [sha, t] of delta.texts) s.texts.set(sha, t);
              content.push({ type: "text", text: renderDeltaDetails(delta, s.title, s.cursor.since) });
              s.cursor = { ...s.cursor, state: delta.state, snapshot: now, since: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
              // Changed figures: show their canvases as they are now.
              const ids = delta.changes.flatMap((c) => c.figureIds ?? []);
              if (ids.length) {
                const index = await readFigIndex(s.cursor.root).catch(() => null);
                const canvases = [...new Set((index?.figures ?? []).filter((f) => ids.includes(f.id)).map((f) => f.canvas))].slice(0, DELTA_IMAGES);
                for (const c of canvases) {
                  try {
                    const { png } = await renderCanvasPng(s.cursor.root, c, 1);
                    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `Canvas ${c} now.` });
                  } catch {
                    /* rendering unavailable: the text names the changed figures */
                  }
                }
              }
            }
            s.notified = now;
            return { content };
          },
        },
      ];
      return tools;
    },
  };
}
