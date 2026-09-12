// Paper text size — persisted exactly like paperLayoutStore.ts / paperViewStore.ts
// (localStorage, one global store shared across Paper panes). All arithmetic
// lives in the pure core next door; this file is persistence and nothing else.

import { writable } from "svelte/store";
import {
  DEFAULT_TEXT_SCALE,
  normalizeTextScale,
  type PaperTextScaleState,
} from "./paperTextScale";

const KEY = "flux.paper.textScale";

function load(): PaperTextScaleState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizeTextScale(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { scale: { ...DEFAULT_TEXT_SCALE.scale }, targets: { ...DEFAULT_TEXT_SCALE.targets } };
}

export const paperTextScale = writable<PaperTextScaleState>(load());

paperTextScale.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
});
