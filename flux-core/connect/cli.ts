// flux connect's CLI-only forms (plan §8.1, §8.8): parts of a stdout-only pack,
// receipt checks, the Claude Code refresh hook's delta path, and folding a CLI
// session's own writes into its cursor so they are never reported back to it.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectAgentIdentity } from "../agentIdentity";
import { readCursor, writeCursor, writePackFile, type SessionCursor } from "./cache";
import { changedPaths, computeDelta, renderDeltaLine, sameSnapshot, takeSnapshot, type DeltaCursor, type StatSnapshot } from "./refresh";
import { checkPackReceipt, connectPart, deltaInputs, describeReceiptCheck, packTexts } from "./index";

function cursorOf(c: SessionCursor): DeltaCursor {
  return { root: c.root, packId: c.packId, since: c.since, state: c.state, snapshot: c.snapshot, text: packTexts(c.packDir) };
}

/** The session key a hook invocation is about: FLUX_HOOK_SESSION (set by the fast path), else the hook JSON on stdin. */
async function hookSessionKey(): Promise<string | null> {
  if (process.env.FLUX_HOOK_SESSION) return process.env.FLUX_HOOK_SESSION;
  if (process.stdin.isTTY) return null;
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    const j = JSON.parse(text) as { session_id?: string };
    return typeof j.session_id === "string" ? j.session_id : null;
  } catch {
    return null;
  }
}

/** The hook's slow path (something changed): print the one-line notice and mark it reported. */
export async function hookDelta(): Promise<string> {
  const key = await hookSessionKey();
  const c = key ? await readCursor(key) : null;
  if (!c) return "";
  const now = await takeSnapshot(c.snapshot.paths);
  if (sameSnapshot(now, c.notified)) return "";
  let line = "";
  try {
    const delta = await computeDelta(deltaInputs(c.root, cursorOf(c), changedPaths(c.snapshot, now), c.key));
    if (delta.changes.length) line = renderDeltaLine(delta, c.since, "`flux connect --refresh`").replace(/^↻ /, `↻ Flux (${c.title}) · `);
  } catch {
    /* never block the user's prompt */
  }
  await writeCursor({ ...c, notified: now }).catch(() => {});
  return line;
}

/**
 * Around one CLI verb in a connected session: if nothing outside moved before
 * the call, fold the call's own writes into the cursor, so the next hook
 * notice speaks only of other people's changes. Returns null (costing one
 * failed file read) when this process is not a connected session.
 */
export async function trackSelfWrites(root: string | null): Promise<{ finish(): Promise<void> } | null> {
  const key = detectAgentIdentity(process.env).sessionId;
  if (!key) return null;
  const c = await readCursor(key);
  if (!c || (root && path.resolve(root) !== c.root && (await fs.realpath(root).catch(() => root)) !== c.root)) return null;
  const before: StatSnapshot = await takeSnapshot(c.snapshot.paths);
  return {
    async finish() {
      try {
        if (!sameSnapshot(before, c.notified)) return; // someone else moved first: the hook reports all of it
        const after = await takeSnapshot(c.snapshot.paths);
        if (sameSnapshot(before, after)) return;
        const delta = await computeDelta(deltaInputs(c.root, cursorOf(c), changedPaths(c.snapshot, after), key));
        for (const [sha, text] of delta.texts) await writePackFile(c.packDir, `src/${sha}.txt`, text).catch(() => {});
        await writeCursor({ ...c, state: delta.state, snapshot: after, notified: after });
      } catch {
        /* advisory */
      }
    },
  };
}

/** `flux connect --part N --pack ID --sources D [target]` · `--check-receipt ID "<proof>"` · `--hook-delta`. */
export async function connectCli(pos: string[], flags: Record<string, unknown>): Promise<void> {
  if (flags["hook-delta"]) {
    const line = await hookDelta();
    if (line) process.stdout.write(line + "\n");
    return;
  }
  if (flags["check-receipt"] !== undefined) {
    const packId = String(flags["check-receipt"]);
    const proof = pos.join(" ");
    if (!proof.trim()) throw new Error('usage: flux connect --check-receipt <packId> "<the receipt\'s Proof line>"');
    const r = await checkPackReceipt(packId, proof);
    console.log(flags.json ? JSON.stringify(r, null, 2) : describeReceiptCheck(r));
    if (!r.complete) process.exitCode = 1;
    return;
  }
  const part = Number(flags.part);
  if (!Number.isInteger(part) || part < 1) throw new Error("--part takes a part number (1, 2, …)");
  if (typeof flags.pack !== "string" || typeof flags.sources !== "string") throw new Error("--part needs --pack <packId> --sources <digest>, exactly as the brief prints them");
  const depth = flags.depth === "full" ? "full" : "core";
  const text = await connectPart({
    target: pos[0],
    depth,
    budget: typeof flags.budget === "string" ? Number(flags.budget) : undefined,
    identity: detectAgentIdentity(process.env),
    part,
    pack: flags.pack,
    sources: flags.sources,
  });
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}
