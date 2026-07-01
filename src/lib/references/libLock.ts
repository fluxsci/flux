// W3 — renderer twin of flux-core's withLockAt: bracket a FluxLib/project
// read-modify-write in an advisory lock over IPC (main writes the same lock
// files flux-core checks, so app↔CLI↔MCP mutations serialize instead of
// interleaving lost updates). Pass-through when no bridge (web demo/fixture —
// single renderer, nothing external to guard). Mutations are ms-scale, so
// contenders retry briefly before giving up with an actionable error.

import { fileBridge } from "../project/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withIpcLock<T>(
  scope: "project" | "fluxlib",
  name: string,
  fn: () => Promise<T>,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<T> {
  const fb = fileBridge();
  if (!fb?.lockAcquire) return fn();
  const retries = opts.retries ?? 8;
  const delayMs = opts.delayMs ?? 250;
  for (let attempt = 0; ; attempt++) {
    const r = await fb.lockAcquire(scope, name);
    if (r.ok) break;
    if (attempt >= retries)
      throw new Error(
        `"${name}" is busy (held by ${r.heldBy ?? "another writer"}) — try again in a moment`,
      );
    await sleep(delayMs);
  }
  try {
    return await fn();
  } finally {
    try {
      await fb.lockRelease?.(scope, name);
    } catch {
      /* TTL will clear it */
    }
  }
}
