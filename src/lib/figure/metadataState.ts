import { writable } from 'svelte/store';
export type MetadataRequest = { figureId?: string; tab: 'captions' | 'name'; pinned: boolean };
export const figureMeta = writable<MetadataRequest | null>(null);
export const figureMetaDetached = writable(false);
export function openFigureMeta(figureId?: string, tab: MetadataRequest['tab'] = 'captions', pinned = false) {
  figureMeta.set({ figureId, tab, pinned });
}
