// Authenticated project-local bridge. Metadata is data, never authority to send
// its token to a remote host, redirect, or unbounded/unresponsive endpoint.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getClient } from './journal';
import type { ContextStamp } from '../src/lib/project/annotations';
interface BridgeInfo { url: string; port: number; token: string; root?: string; sessionId?: string }
export function decodeBridge(value: unknown): BridgeInfo | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Record<string, unknown>;
  if (typeof b.url !== 'string' || typeof b.token !== 'string' || !b.token || b.token.length > 4096 || !Number.isInteger(b.port) || Number(b.port) < 1 || Number(b.port) > 65535) return null;
  try {
    const u = new URL(b.url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || Number(u.port) !== b.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    return { url: u.origin, port: Number(b.port), token: b.token, ...(typeof b.root === "string" ? {root:b.root} : {}), ...(typeof b.sessionId === "string" ? {sessionId:b.sessionId} : {}) };
  } catch { return null; }
}
async function readBridge(root: string): Promise<BridgeInfo | null> {
  try {
    const file = path.join(root, '.meta/live/bridge.json');
    if ((await fs.stat(file)).size > 16384) return null;
    const bridge = decodeBridge(JSON.parse(await fs.readFile(file, 'utf8')));
    if (bridge?.root && await fs.realpath(bridge.root) !== await fs.realpath(root)) return null;
    return bridge;
  } catch { return null; }
}
async function request(b: BridgeInfo, route: string, body?: unknown, sessionId?: string): Promise<unknown> {
  const response = await fetch(`${b.url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json', 'x-flux-client': encodeURIComponent(getClient()), ...(sessionId ? {'x-flux-session': encodeURIComponent(sessionId)} : {}), ...(b.root ? {'x-flux-project':b.root} : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(route === '/approve' ? 125000 : route === '/dispatch' ? 30000 : route === '/capture' ? 15000 : 3000) });
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`bridge ${route}: empty response`);
  let size = 0; const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    const limitMiB = route === '/capture' ? 16 : 4;
    if (size > limitMiB * 1024 * 1024) { await reader.cancel(); throw new Error(`bridge ${route}: response exceeds ${limitMiB} MiB`); }
    chunks.push(value);
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error(`bridge ${route}: invalid JSON (${response.status})`); }
  const error = result && typeof result === 'object' && 'error' in result ? String(result.error) : '';
  if (!response.ok) throw new Error(error === 'live-view-disabled' ? 'live-view-disabled: Allow agents to view the Flux window is off in Settings.' : error || `bridge ${route} returned ${response.status}`);
  return result;
}
export async function bridgeAvailable(root: string): Promise<boolean> {
  const b = await readBridge(root); if (!b) return false;
  try { const result = await request(b, '/health'); return !!result && typeof result === 'object' && 'ok' in result && result.ok === true && (!b.root || 'root' in result && result.root === b.root) && (!b.sessionId || 'sessionId' in result && result.sessionId === b.sessionId); } catch { return false; }
}
function notOpen(): never { throw new Error('Flux app is not open for this project (missing or invalid local bridge metadata). Use the file verbs instead.'); }
export async function getAppContext(root: string): Promise<unknown> {
  const b = await readBridge(root); if (!b) notOpen();
  return request(b, '/context');
}
export async function getView(root: string, maxEdge?: number, sessionId?: string): Promise<{ png: string; stamp: ContextStamp }> {
  const b = await readBridge(root); if (!b) notOpen();
  const result = await request(b, '/capture', { maxEdge }, sessionId) as { png?: unknown; stamp?: ContextStamp };
  if (typeof result?.png !== 'string' || !result.stamp || typeof result.stamp.surface !== 'string' ||
      !Buffer.from(result.png, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('bridge /capture: invalid PNG or context stamp');
  return { png: result.png, stamp: result.stamp };
}
export async function dispatchCommand(root: string, command: unknown): Promise<unknown> {
  const b = await readBridge(root); if (!b) notOpen();
  const j = await request(b, '/dispatch', command) as { ok?: boolean; result?: unknown; error?: string };
  if (j.ok !== true) throw new Error(j.error || 'bridge dispatch refused');
  return j.result;
}

/** Permission-prompt-tool responses always fail closed, including bridge loss. */
export async function approve(root: string, token: string, permission: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  try {
    const b = await readBridge(root); if (!b) throw new Error("Flux app is not reachable");
    const result = await request(b, "/approve", { token, ...permission }) as { behavior?: string; message?: string };
    if (result?.behavior === "allow") return { behavior: "allow", updatedInput: permission.input };
    return { behavior: "deny", message: result?.message || "Permission denied" };
  } catch (e) { return { behavior: "deny", message: (e as Error).message }; }
}
