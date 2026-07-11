// flux-core/journal.ts — client identity + the .meta/journal.ndjson provenance
// log (split out of index.ts; WS-6.2). Lowest layer of flux-core: everything
// that writes a project journals through here, stamped with CLIENT.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setLockClient } from "./locks";

// WS6 — client identity, stamped on every journal entry and used as lock owner.
// The CLI sets "cli", the MCP server "mcp"; the GUI writes as "human" and the
// live bridge as "agent" through their own paths. Defaults to "flux-core".
export let CLIENT = process.env.FLUX_CLIENT || "flux-core";
export function setClient(c: string): void {
  CLIENT = c;
  setLockClient(c); // keep the lock layer's identity in sync (fluxlib.ts uses it)
}
export function getClient(): string {
  return CLIENT;
}

export const j = (...p: string[]) => path.join(...p);

export function stamp(): string {
  return new Date().toISOString();
}

/** Append a provenance line to .meta/journal.ndjson.
 *  W2: O_APPEND (not read-whole-rewrite) — concurrent writers can no longer drop
 *  each other's entries and cost stays O(1); size-based rotation keeps it bounded. */
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
export async function journal(root: string, entry: Record<string, unknown>): Promise<void> {
  const p = j(root, ".meta", "journal.ndjson");
  await fs.mkdir(path.dirname(p), { recursive: true });
  try {
    const st = await fs.stat(p);
    if (st.size > JOURNAL_MAX_BYTES)
      await fs.rename(p, j(root, ".meta", `journal-${Date.now()}.ndjson`));
  } catch {
    /* no journal yet */
  }
  await fs.appendFile(p, JSON.stringify({ ts: stamp(), client: CLIENT, ...entry }) + "\n");
}
