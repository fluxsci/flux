/** Project-scoped read-only snapshots. IO and notifications are supplied by the host. */
import { readEmbedDeck, gatherSlidePayload, underRoot, type SlidePayloadIO, type ExportPayload } from "./payload";
import { embedKey, posterPath, type SlideEmbedRef } from "./embed";
import { renderSlidePosterSvg } from "./embedRender";
import type { Deck } from "./types";
export interface SlideSnapshot { payload: ExportPayload; poster: string; signature: string; warnings: string[] }
export interface SlideRepositoryIO extends SlidePayloadIO { prepareDeck?(id: string): Promise<string[]>; exists?(p: string): Promise<boolean>; writeText?(p: string, text: string): Promise<void>; mkdir?(p: string): Promise<void> }
export interface EmbedDeckRow { id: string; title: string; count?: number; error?: string }
export function createSlideRepository(root: string, io: SlideRepositoryIO) {
  const snapshots = new Map<string, SlideSnapshot>(), pending = new Map<string, Promise<SlideSnapshot>>();
  const decks = new Map<string, Promise<Deck>>(), listeners = new Set<() => void>();
  let generation = 0, active = 0, disposed = false;
  const sourceWarnings = new Map<string, string[]>();
  const queue: (() => void)[] = [];
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= 2) await new Promise<void>(r => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  }
  function deck(id: string) {
    let p = decks.get(id);
    if (!p) { p = readEmbedDeck(root, id, io); decks.set(id, p); }
    return p;
  }
  const preparedDecks = new Map<string, Promise<Deck>>();
  function preparedDeck(id: string) {
    let p = preparedDecks.get(id);
    if (!p) {
      p = (async () => {
        sourceWarnings.set(id, await io.prepareDeck?.(id) ?? []);
        if (!io.prepareDeck) return deck(id);
        const result = readEmbedDeck(root, id, io); decks.set(id, result); return result;
      })();
      preparedDecks.set(id, p);
    }
    return p;
  }
  async function load(ref: Pick<SlideEmbedRef, "deck" | "slide">): Promise<SlideSnapshot> {
    if (disposed) throw new Error("Slide repository closed");
    const key = embedKey(ref), current = pending.get(key);
    if (current) return current;
    const stamp = generation;
    const p = limited(async () => {
      const d = await preparedDeck(ref.deck), result = await gatherSlidePayload(root, d, ref.slide, io);
      result.warnings.unshift(...sourceWarnings.get(ref.deck) ?? []);
      const signature = JSON.stringify(result);
      const old = snapshots.get(key);
      if (old?.signature === signature) return old;
      const fonts = (await import("../../../.generated/slide-embed-assets.json")).default.fonts;
      const poster = renderSlidePosterSvg(result.payload).replace("</svg>", `<style>${fonts}</style></svg>`);
      const next = { ...result, poster, signature };
      if (stamp === generation && !disposed) {
        if (snapshots.size >= 100) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(key, next);
      }
      return next;
    });
    if (pending.size >= 100) pending.delete(pending.keys().next().value!);
    pending.set(key, p);
    try { const result = await p; if (disposed) throw new Error("Slide repository closed"); if (stamp !== generation) { if (pending.get(key) === p) pending.delete(key); return load(ref); } return result; }
    finally { if (pending.get(key) === p && stamp !== generation) pending.delete(key); }
  }
  async function materialize(ref: Pick<SlideEmbedRef, "deck" | "slide">): Promise<SlideSnapshot> {
    const snapshot = await load(ref);
    if (disposed) throw new Error("Slide repository closed");
    if (snapshot.warnings.some(w => /its element will show a placeholder|missing from the export|no parts tree/.test(w))) throw new Error(snapshot.warnings.join("\n"));
    if (io.writeText) {
      const rel = posterPath(ref.deck, ref.slide), path = underRoot(root, rel);
      const prior = io.exists && await io.exists(path) ? await io.readText(path) : null;
      if (prior !== snapshot.poster) { await io.mkdir?.(path.slice(0, path.lastIndexOf("/"))); await io.writeText(path, snapshot.poster); }
    }
    return snapshot;
  }
  return { root, deck, load, materialize,
    async list(): Promise<EmbedDeckRow[]> {
      const m = JSON.parse(await io.readText(underRoot(root, "project.json")));
      return [...(m.slides ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(d => ({ id: d.id, title: d.title || d.id }));
    },
    invalidate() { if (disposed) return; generation++; decks.clear(); preparedDecks.clear(); sourceWarnings.clear(); pending.clear(); for (const fn of listeners) fn(); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    dispose() { disposed = true; generation++; pending.clear(); decks.clear(); preparedDecks.clear(); snapshots.clear(); listeners.clear(); },
  };
}
export type SlideRepository = ReturnType<typeof createSlideRepository>;
