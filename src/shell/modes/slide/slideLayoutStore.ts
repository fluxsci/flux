import { decodePreferences } from "../../../lib/preferences";
// Slide-module layout preferences — persisted to localStorage exactly like
// paper's view-mode/paperLayoutStore.ts. Holds the three reader-adjustable pane
// sizes (filmstrip width, inspector width, Animator dock height) in px. A
// single global store shared across the slide UI (MVP).

import { writable } from "svelte/store";

export interface SlideLayout {
  /** Filmstrip (left rail) width in px. */
  filmstripW: number;
  /** Inspector (right rail) width in px. */
  inspectorW: number;
  /** Animator dock height in px (the dock still grows to content under this cap). */
  animatorH: number;
}

const KEY = "flux.slide.layout";

// Defaults match the values the panes shipped with as fixed flex bases.
const DEFAULTS: SlideLayout = { filmstripW: 172, inspectorW: 248, animatorH: 360 };

function load(): SlideLayout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return decodePreferences(JSON.parse(raw), DEFAULTS, { filmstripW: {min:120,max: Math.max(172, typeof window === "undefined" ? 1920 : window.innerWidth * .5)}, inspectorW: {min:200,max:Math.max(248,typeof window === "undefined" ? 1536 : window.innerWidth * .4)}, animatorH: {min:120,max:typeof window === "undefined" ? 1080 : window.innerHeight} });
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const slideLayout = writable<SlideLayout>(load());

slideLayout.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
});
