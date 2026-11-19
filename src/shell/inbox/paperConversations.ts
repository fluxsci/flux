// The open project's Inbox, mirrored onto the papers it talks about. An item made while reading
// (a passage, a highlight, a mark on a page) is copied into that paper's own conversations file in
// FluxLib, by item id, so the same paper opened from ANY project shows the question and its
// answers. The project ledger stays the one place the item is claimed and answered; this only
// follows it. flux-core does the same after an agent's reply (flux-core/conversations.ts), so an
// answer that lands while another project is open still reaches the paper.
//
// Cost discipline: called on every Inbox refresh, it compares one short signature per paper item
// and returns; the files are read and written only for items whose signature moved, in idle time.
import { get } from "svelte/store";
import type { InboxItem } from "../../lib/project/inbox";
import { threadFromItem, threadSignature, type PaperOrigin, type PaperThread } from "../../lib/references/conversations";
import { currentProject, projectModel } from "../shellStore";

/** Where a thread made in the open project says it came from. */
export function projectOrigin(root: string): Omit<PaperOrigin, "kind"> {
  const model = get(projectModel), manifest = model?.root === root ? model.manifest : null;
  const title = manifest?.title || get(currentProject)?.name || root.split(/[\\/]/).filter(Boolean).pop() || "a project";
  return { project: { ...(manifest?.id ? { id: manifest.id } : {}), title }, root };
}

interface Due { key: string; signature: string; citekey: string; thread: PaperThread }
const written = new Map<string, string>(), tries = new Map<string, number>();
let due = new Map<string, Due>(), scheduled = false;

async function flush(): Promise<void> {
  scheduled = false;
  const batch = [...due.values()]; due = new Map();
  if (!batch.length) return;
  const byPaper = new Map<string, Due[]>();
  for (const d of batch) { const list = byPaper.get(d.citekey); if (list) list.push(d); else byPaper.set(d.citekey, [d]); }
  const { saveThreads } = await import("../../lib/references/conversationsBridge");
  for (const [citekey, list] of byPaper) {
    try {
      await saveThreads(citekey, list.map(d => d.thread));
      for (const d of list) { written.set(d.key, d.signature); tries.delete(d.key); }
    } catch (e) {
      // A paper whose file cannot be read or locked is retried a few times, then left alone until
      // the item changes: a refresh every few seconds must never become a write storm.
      for (const d of list) { const n = (tries.get(d.key) ?? 0) + 1; tries.set(d.key, n); if (n >= 3) { written.set(d.key, d.signature); tries.delete(d.key); } }
      console.warn(`[flux] conversations for ${citekey} were not saved:`, e);
    }
  }
}

export function mirrorPaperItems(root: string, items: readonly InboxItem[]): void {
  let origin: Omit<PaperOrigin, "kind"> | null = null;
  for (const item of items) {
    if (item.kind !== "annotation" || (!item.citekey && !item.targets.some(t => t.kind === "passage"))) continue;
    const made = threadFromItem(item, origin ??= projectOrigin(root));
    if (!made) continue;
    const key = `${root}\n${item.id}`, signature = threadSignature(made.thread);
    if (written.get(key) === signature) { due.delete(key); continue; }
    due.set(key, { key, signature, citekey: made.citekey, thread: made.thread });
  }
  if (!due.size || scheduled) return;
  scheduled = true;
  const idle = (globalThis as { requestIdleCallback?: (run: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(() => void flush(), { timeout: 2000 }); else setTimeout(() => void flush(), 200);
}

/** For gates: the mirror's pending work, done. */
export async function settlePaperMirror(): Promise<void> {
  while (due.size || scheduled) { await flush(); await new Promise(r => setTimeout(r, 0)); }
}
