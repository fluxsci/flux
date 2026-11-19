// flux-core/conversations.ts — a paper's Flux AI conversations (Node side: CLI/MCP/agents).
// They live with the paper, items/<citekey>/conversations.json in FluxLib, beside its
// highlights; the model is src/lib/references/conversations.ts and the renderer twin is
// src/lib/references/conversationsBridge.ts.
//
// An Inbox item made while reading is copied here by item id whenever an agent changes it
// (claim, reply, resolve), so the answer shows on the paper from ANY project, including one that
// is open while the item's own project is not. The project ledger remains the record: this never
// fails the write it follows, and it never makes a highlight (the app does that when the thread is
// first seen there).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveFluxLibPath } from "./fluxlib";
import { prepareItemLocators } from "./itemLocators";
import { atomicWrite } from "./fsx";
import { fluxlibLockDir, getLockClient, withLockAt, assertLockOwned } from "./locks";
import { loadManifest } from "./model";
import { loadAnnotations } from "./annotate";
import { conversationsPath, itemDir, safeKey } from "../src/lib/references/items";
import { readCanonicalText, parseCanonical, rememberCanonical, assertCanonicalSnapshot } from "../src/lib/references/canonical";
import { emptyConversationFile, validateConversations, threadFromItem, upsertThread, highlightFor, earlierThreads,
  type ConversationFile, type PaperThread } from "../src/lib/references/conversations";
import type { InboxItem } from "../src/lib/project/inbox";

async function lib(libPath?: string): Promise<string> {
  const root = libPath ? path.resolve(libPath) : await resolveFluxLibPath();
  await prepareItemLocators(root);
  return root;
}

export async function loadConversations(key: string, libPath?: string): Promise<ConversationFile> {
  const p = conversationsPath(await lib(libPath), key);
  const text = await readCanonicalText(p, () => fs.readFile(p, "utf8"));
  return rememberCanonical(text === null ? emptyConversationFile() : parseCanonical(p, text, validateConversations), p, text);
}

export async function listConversations(key: string, libPath?: string): Promise<PaperThread[]> {
  return (await loadConversations(key, libPath)).threads;
}

/** Earlier exchanges about the same words: what an agent asked about a passage again should know. */
export async function earlierOnPassage(about: { citekey: string; page: number; quote?: string; highlightId?: string }, except?: string, libPath?: string) {
  const { threads } = await loadConversations(about.citekey, libPath);
  return earlierThreads(threads, { page: about.page, highlightId: about.highlightId, ...(about.quote ? { anchor: { quote: about.quote } } : {}) }, except);
}

/**
 * Copy an Inbox item onto the paper it was made on. Resolves to whether the paper's file changed
 * (false for an item that is not about a paper, or a paper that is not in the library).
 */
export async function followPaperItem(root: string, item: InboxItem, libPath?: string): Promise<boolean> {
  if (item.kind !== "annotation") return false;
  const manifest = await loadManifest(root).catch(() => null);
  const made = threadFromItem(item, { project: { ...(manifest?.id ? { id: manifest.id } : {}), title: manifest?.title || path.basename(root) }, root });
  if (!made) return false;
  const L = await lib(libPath), key = made.citekey;
  try { if (!(await fs.stat(itemDir(L, key))).isDirectory()) return false; } catch { return false; }
  return withLockAt(fluxlibLockDir(L), `conversations-${safeKey(key)}`, getLockClient(), async lease => {
    const file = await loadConversations(key, L), result = upsertThread(file, made.thread);
    if (!result.changed) return false;
    if (result.added && !made.thread.highlightId) {
      const on = highlightFor(made.thread, (await loadAnnotations(key, L)).annotations);
      if (on) made.thread.highlightId = on.id; // `made.thread` is the object upsertThread stored
    }
    const p = conversationsPath(L, key);
    await assertCanonicalSnapshot(file, q => readCanonicalText(q, () => fs.readFile(q, "utf8")));
    validateConversations(file);
    await assertLockOwned(lease);
    await atomicWrite(p, JSON.stringify(file, null, 2) + "\n");
    return true;
  }, { retries: 4 });
}
