// The Claude Code UserPromptSubmit hook, fast path (plan §8.8 Delivery 2). It
// runs on every prompt in EVERY Claude Code session on the machine, so the
// common cases (not a connected session; nothing changed) must finish in a
// few milliseconds without loading the core. Only when something changed does
// the hook hand over to the core CLI, which computes and prints the notice.

import { readCursor } from "./cache";
import { sameSnapshot, takeSnapshot } from "./refresh";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** "quiet" = print nothing; otherwise the session whose project changed. */
export async function hookFastPath(stdin?: string): Promise<"quiet" | { key: string }> {
  let key: string | null = null;
  try {
    const j = JSON.parse(stdin ?? (await readStdin())) as { session_id?: unknown };
    key = typeof j.session_id === "string" ? j.session_id : null;
  } catch {
    return "quiet";
  }
  if (!key) return "quiet";
  const c = await readCursor(key);
  if (!c) return "quiet";
  const now = await takeSnapshot(c.snapshot.paths);
  return sameSnapshot(now, c.notified) ? "quiet" : { key };
}
