import { decodePreferences } from "../../../lib/preferences";
// Reader rail widths + which right-rail tab is showing — module-global (shared by
// every paper and both split panes), persisted to localStorage. Follows the
// figure/slide/paper layout-store pattern: widths are a workspace preference, while
// VISIBILITY stays per-paper (showRefs/showAnnots ride flux-reader-view:<citekey>,
// so a paper you read with the references open reopens that way).
import { writable } from "svelte/store";

export interface ReaderLayout {
  /** Left rail (references / citers / outline). */
  refsW: number;
  /** Right rail (annotations / library search). */
  annotsW: number;
  /** Which right-rail tab is showing — sticky, so an Alt+R search panel stays put. */
  rightTab: "annots" | "library";
  /** Terminal drawer height, in px (drag its top edge; double-click resets). */
  terminalH: number;
}

const KEY = "flux.reader.layout";

export const READER_LAYOUT_DEFAULTS: ReaderLayout = { refsW: 268, annotsW: 268, rightTab: "annots", terminalH: 300 };

function load(): ReaderLayout {
  try {
    const raw = localStorage.getItem(KEY);
    // Spread-merge so a field added later gets its default for existing users.
    return decodePreferences(raw ? JSON.parse(raw) : null, READER_LAYOUT_DEFAULTS, {refsW:{min:180,max:520},annotsW:{min:180,max:560},rightTab:{enum:["annots","library"]},terminalH:{min:120,max:typeof window === "undefined" ? 1080 : window.innerHeight}});
  } catch {
    return { ...READER_LAYOUT_DEFAULTS };
  }
}

export const readerLayout = writable<ReaderLayout>(load());

readerLayout.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full/blocked — layout is best-effort */
  }
});
