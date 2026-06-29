// WS4 — the client half of the live agent bridge, used by the MCP server. Reads
// the per-session token + port from `<root>/.meta/live/bridge.json` (written by the
// app when a project is open) and talks to the loopback control server. When the
// app is closed there is no bridge file, so callers fall back to the file verbs.

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface BridgeInfo {
  url: string;
  port: number;
  token: string;
}

async function readBridge(root: string): Promise<BridgeInfo | null> {
  try {
    const b = JSON.parse(await fs.readFile(path.join(root, ".meta", "live", "bridge.json"), "utf8"));
    if (b && typeof b.url === "string" && typeof b.token === "string") return b as BridgeInfo;
  } catch {
    /* no bridge file → app not open */
  }
  return null;
}

const auth = (b: BridgeInfo) => ({ authorization: `Bearer ${b.token}` });

/** Is the Flux app open with this project (bridge reachable)? */
export async function bridgeAvailable(root: string): Promise<boolean> {
  const b = await readBridge(root);
  if (!b) return false;
  try {
    const r = await fetch(`${b.url}/health`, { headers: auth(b) });
    return r.ok;
  } catch {
    return false;
  }
}

function notOpen(): never {
  throw new Error("Flux app is not open for this project (no .meta/live/bridge.json). Use the file verbs (compose_figure, restyle_part, …) instead.");
}

/** The live UI context (what the human has selected / is viewing). */
export async function getAppContext(root: string): Promise<unknown> {
  const b = await readBridge(root);
  if (!b) notOpen();
  const r = await fetch(`${b.url}/context`, { headers: auth(b) });
  if (!r.ok) throw new Error(`bridge /context returned ${r.status}`);
  return r.json();
}

/** Apply an allow-listed command to the live app (the same undoable edit a human makes). */
export async function dispatchCommand(root: string, command: unknown): Promise<unknown> {
  const b = await readBridge(root);
  if (!b) notOpen();
  const r = await fetch(`${b.url}/dispatch`, {
    method: "POST",
    headers: { ...auth(b), "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error || `bridge /dispatch returned ${r.status}`);
  return j.result;
}
