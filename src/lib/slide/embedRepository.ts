/** Project-scoped read-only snapshots. IO and notifications are supplied by the host. */
import { readEmbedDeck, gatherSlidePayload, underRoot, type SlidePayloadIO, type ExportPayload } from "./payload";
import { embedKey, posterPath, type SlideEmbedRef } from "./embed";
import { renderSlidePosterSvg } from "./embedRender";
import { loadEmbedAssets } from './embedAssets';
import type { Deck } from "./types";
import type { Model3dAsset } from '../model3d/types';
export interface EmbedModelSource { root: string; scope: string; assets: Model3dAsset[]; isCurrent(): boolean }
export interface SlideSnapshot { payload: ExportPayload; poster: string; signature: string; warnings: string[]; modelSource?: EmbedModelSource }
export interface SlideRepositoryIO extends SlidePayloadIO { prepareDeck?(id: string): Promise<string[]>; exists?(p: string): Promise<boolean>; writeText?(p: string, text: string): Promise<void>; mkdir?(p: string): Promise<void> }
export interface EmbedDeckRow { id: string; title: string; count?: number; error?: string }
let repositorySequence = 0;
export function createSlideRepository(root: string, io: SlideRepositoryIO) {
  const sourceId = ++repositorySequence;
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
  // Portable snapshots the interactive Paper preview reuses between renders
  // (it re-renders ~160 ms after every edit). Keyed by embed; valid while the
  // metadata snapshot's content signature is unchanged: that signature covers
  // the deck (every slide, and each GLB's prepared sha256) and all gathered
  // image/plot bytes, and published GLB files are immutable. One base64 copy
  // per prepared sha256 is shared across cached slides.
  const portables = new Map<string, { signature: string; value: Promise<SlideSnapshot | null>; shas: string[] }>();
  const modelText = new Map<string, string>();
  function forgetPortable(key: string, entry?: { value: Promise<SlideSnapshot | null> }) {
    if (entry && portables.get(key) !== entry) return;
    portables.delete(key);
    const live = new Set([...portables.values()].flatMap(e => e.shas));
    for (const sha of modelText.keys()) if (!live.has(sha)) modelText.delete(sha);
  }
  function shareModelText(snapshot: SlideSnapshot): string[] {
    const models = snapshot.payload.models ?? {}, shas: string[] = [];
    for (const asset of snapshot.payload.deck.assets) {
      if (asset.kind !== 'glb' || !Object.hasOwn(models, asset.id)) continue;
      const sha = (asset as Model3dAsset).sha256.toLowerCase(), text = models[asset.id], prior = modelText.get(sha);
      if (prior !== undefined && prior.length === text.length) models[asset.id] = prior; else modelText.set(sha, text);
      shas.push(sha);
    }
    return shas;
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
      if (old?.signature === signature && (!old.modelSource || old.modelSource.isCurrent())) return old;
      const fonts = (await loadEmbedAssets()).fonts;
      const poster = renderSlidePosterSvg(result.payload).replace("</svg>", `<style>${fonts}</style></svg>`);
      const modelAssets = result.payload.deck.assets.filter((a): a is Model3dAsset => a.kind === 'glb');
      // Portable payloads deliberately erase private paths. Resolve live file
      // ownership from the saved registries, never from that scrubbed copy.
      const external = io.modelData === 'omit' && modelAssets.some(a => !d.assets.some(own => own.id === a.id))
        ? JSON.parse(await io.readText(underRoot(root, 'fig/index.json'))).assets as Model3dAsset[] : [];
      const modelSource = io.modelData === 'omit' && modelAssets.length ? { root, scope: `paper-slides:${root}:${sourceId}:${stamp}`,
        assets: modelAssets.map(a => {
          const owned = d.assets.find(own => own.id === a.id), saved = owned ?? external.find(own => own.id === a.id);
          if (!saved?.path || saved.kind !== 'glb') throw new Error(`Missing Paper model file metadata: ${a.id}`);
          return { ...a, path: `${owned ? `slides/${d.id}` : 'fig'}/${saved.path}` };
        }),
        isCurrent: () => stamp === generation && !disposed } : undefined;
      const next = { ...result, poster, signature, ...(modelSource ? { modelSource } : {}) };
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
  /** Native authoring capabilities expire with their project/window. HTML
   * exports gather real bytes into an export-only snapshot; keep the live
   * repository cache streamed, and keep static exports poster-only. Null means
   * the repository was invalidated while gathering. */
  async function gatherPortable(ref: Pick<SlideEmbedRef, "deck" | "slide">, base: SlideSnapshot, stamp: number): Promise<SlideSnapshot | null> {
    const d = await preparedDeck(ref.deck);
    const portable = await gatherSlidePayload(root, d, ref.slide, { ...io, videoUrl: undefined, modelData: 'inline' });
    portable.warnings.unshift(...sourceWarnings.get(ref.deck) ?? []);
    if (disposed) throw new Error("Slide repository closed");
    if (stamp !== generation) return null;
    if (portable.warnings.some(w => /its element will show a placeholder|missing from the export|no parts tree/.test(w))) throw new Error(portable.warnings.join("\n"));
    return { ...portable, poster: base.poster, signature: JSON.stringify(portable) };
  }
  /** `reusePortable` (the interactive preview only) serves an unchanged
   * slide's portable snapshot without re-reading, re-hashing and re-encoding
   * its GLBs. Exports never pass it: they gather and validate fresh bytes. */
  async function materialize(ref: Pick<SlideEmbedRef, "deck" | "slide">, options: { portable?: boolean; reusePortable?: boolean } = {}): Promise<SlideSnapshot> {
    let snapshot = await load(ref);
    if (disposed) throw new Error("Slide repository closed");
    if (snapshot.warnings.some(w => /its element will show a placeholder|missing from the export|no parts tree/.test(w))) throw new Error(snapshot.warnings.join("\n"));
    if (io.writeText) {
      const rel = posterPath(ref.deck, ref.slide), path = underRoot(root, rel);
      const prior = io.exists && await io.exists(path) ? await io.readText(path) : null;
      if (prior !== snapshot.poster) { await io.mkdir?.(path.slice(0, path.lastIndexOf("/"))); await io.writeText(path, snapshot.poster); }
    }
    if (options.portable && (snapshot.modelSource || Object.values(snapshot.payload.videos ?? {}).some(url => !url.startsWith("data:video/")))) {
      const key = embedKey(ref), stamp = generation;
      let entry = options.reusePortable ? portables.get(key) : undefined;
      if (entry && entry.signature !== snapshot.signature) { forgetPortable(key, entry); entry = undefined; }
      if (!entry) {
        const value = gatherPortable(ref, snapshot, stamp);
        entry = { signature: snapshot.signature, value, shas: [] };
        if (options.reusePortable) {
          const own = entry;
          portables.delete(key); portables.set(key, own);
          if (portables.size > 32) forgetPortable(portables.keys().next().value!);
          value.then(result => { if (result && !disposed && portables.get(key) === own) own.shas = shareModelText(result); else forgetPortable(key, own); },
            () => forgetPortable(key, own));
        }
      } else { portables.delete(key); portables.set(key, entry); }
      const portable = await entry.value;
      if (disposed) throw new Error("Slide repository closed");
      if (!portable) return materialize(ref, options);
      snapshot = { ...portable, poster: snapshot.poster };
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
    dispose() { disposed = true; generation++; pending.clear(); decks.clear(); preparedDecks.clear(); snapshots.clear(); portables.clear(); modelText.clear(); listeners.clear(); },
  };
}
export type SlideRepository = ReturnType<typeof createSlideRepository>;
