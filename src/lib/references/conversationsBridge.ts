// Renderer-side persistence of a paper's conversations (the twin of flux-core/conversations.ts)
// over window.fig: items/<citekey>/conversations.json in FluxLib. Same write discipline as the
// highlights beside it (annotationsBridge.ts): every change is a read-modify-write of the whole
// file, serialized per citekey in this renderer and run under the FluxLib IPC lock so an agent's
// flux-core write cannot interleave.
import { writable } from "svelte/store";
import { fileBridge } from "../project/types";
import { parseCanonical, rememberCanonical, assertCanonicalSnapshot } from "./canonical";
import { resolveFluxLibPath } from "./fluxlibBridge";
import { conversationsPath, itemDir, safeKey } from "./items";
import { withIpcLock } from "./libLock";
import { seededItem } from "./devSeed";
import { addAnnotation, loadAnnotations } from "./annotationsBridge";
import { emptyConversationFile, validateConversations, upsertThread, removeThread, highlightFor, wantsHighlight,
  type ConversationFile, type PaperThread } from "./conversations";

/** The colour of a highlight Flux makes for a conversation (Flux AI's own blue; recolour it freely). */
export const CONVERSATION_HIGHLIGHT = "blue";

// Bumped after every in-app write, by citekey: an open Reader on that paper reloads its threads.
// Writes by an agent (flux-core) arrive through the FluxLib watcher (fluxLibRevision) instead.
export const conversationsRev = writable<{ key: string; n: number }>({ key: "", n: 0 });
let revN = 0;
const bump = (key: string) => conversationsRev.set({ key, n: ++revN });

const tails = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
  tails.set(key, run.catch(() => undefined));
  return run;
}
const locked = <T>(key: string, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> =>
  enqueue(key, () => withIpcLock("fluxlib", `conversations-${safeKey(key)}`, lease => fn(async () => { await lease.assertOwned?.(); })));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
// A seeded paper (the dev/gate stand-in for an item on disk) keeps its conversations in memory.
const seededTalk = new Map<string, ConversationFile>();

export async function loadConversations(key: string): Promise<ConversationFile> {
  if (seededItem(key)) return clone(seededTalk.get(key) ?? emptyConversationFile());
  const fb = fileBridge(), lib = await resolveFluxLibPath();
  if (!fb || !lib) return emptyConversationFile();
  const p = conversationsPath(lib, key);
  const text = (await fb.exists(p)) ? await fb.readText(p) : null;
  return rememberCanonical(text == null ? emptyConversationFile() : parseCanonical(p, text, validateConversations), p, text);
}

/**
 * One locked read-modify-write. `change` edits the file in place and says whether it did. A paper
 * that is not in the library (no item folder) is never written: conversations follow the paper,
 * they do not create one. Resolves to whether anything was saved.
 */
async function change(key: string, edit: (file: ConversationFile) => boolean | Promise<boolean>): Promise<boolean> {
  return locked(key, async assertOwned => {
    if (seededItem(key)) {
      const file = clone(seededTalk.get(key) ?? emptyConversationFile());
      if (!await edit(file)) return false;
      seededTalk.set(key, validateConversations(file)); bump(key);
      return true;
    }
    const fb = fileBridge(), lib = await resolveFluxLibPath();
    if (!fb || !lib || !await fb.exists(itemDir(lib, key))) return false;
    const file = await loadConversations(key);
    if (!await edit(file)) return false;
    await assertCanonicalSnapshot(file, async p => await fb.exists(p) ? await fb.readText(p) : null);
    validateConversations(file);
    await assertOwned();
    await fb.writeText(conversationsPath(lib, key), JSON.stringify(file, null, 2) + "\n");
    bump(key);
    return true;
  });
}

/**
 * Save threads onto their paper. A thread about selected words is hung on a highlight: the one it
 * names, one already on the same words, or (for a real text selection on the main PDF) a highlight
 * made for it now. A thread that already hangs on one keeps it.
 */
export function saveThreads(key: string, threads: readonly PaperThread[]): Promise<boolean> {
  return change(key, async file => {
    let changed = false, highlights: Awaited<ReturnType<typeof loadAnnotations>>["annotations"] | null = null;
    for (const incoming of threads) {
      changed = upsertThread(file, clone(incoming)).changed || changed;
      // Hang it on a highlight if it has none yet (an agent's reply may have written the thread
      // before this app saw it). A thread whose highlight was deleted keeps its dead link, so
      // deleting a highlight is never undone here.
      const thread = file.threads.find(t => t.id === incoming.id);
      if (!thread || thread.highlightId || thread.source || !thread.anchor) continue;
      highlights ??= (await loadAnnotations(key)).annotations;
      let on = highlightFor(thread, highlights);
      if (!on && wantsHighlight(thread)) {
        on = await addAnnotation(key, { page: thread.page, anchor: { quote: thread.anchor.quote, prefix: thread.anchor.prefix, suffix: thread.anchor.suffix }, color: CONVERSATION_HIGHLIGHT });
        highlights = [...highlights, on];
      }
      if (on) { thread.highlightId = on.id; changed = true; }
    }
    return changed;
  });
}

/** Take a thread off its paper. `forget` keeps a mirror from bringing an Inbox item's copy back. */
export function forgetThread(key: string, id: string, forget: boolean): Promise<boolean> {
  return change(key, file => removeThread(file, id, forget));
}

/** Undo of forgetThread: the thread is back on its paper, and no longer marked as removed. */
export function restoreThread(key: string, thread: PaperThread): Promise<boolean> {
  return change(key, file => {
    if (file.removed) { delete file.removed[thread.id]; if (!Object.keys(file.removed).length) delete file.removed; }
    if (!file.threads.some(t => t.id === thread.id)) file.threads.push(clone(thread));
    return true;
  });
}
