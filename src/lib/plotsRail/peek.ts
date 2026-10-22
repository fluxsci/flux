// Peek — the Plots rail's information surface (PLAN §4.7). A tile can't carry metadata in a
// 300 px rail, so a non-interactive popover beside the rail does: after a 350 ms dwell on a tile
// (an intent filter, not masked latency), or Shift+Space for the focused tile. Once up it follows
// the pointer from tile to tile without a new dwell. It hides the instant the pointer leaves the
// rail (it must never cover where the pointer is heading), on scroll, on any key, on a press.
//
// One controller per app: the rail's two panes feed it, PlotsRail renders the one <Peek>.

import { writable, get } from "svelte/store";
import type { TablePreview } from "./tableCard";
import type { InkStats } from "./rules";

export const PEEK_DWELL_MS = 350;

export interface PlotPeek {
  kind: "plot";
  abs: string;
  stamp: string;
  name: string;
  /** Folder shown under the name ("plots/figs/latency", "plot_library/…"). */
  folder: string;
  aspect: number;
  physMm: [number, number] | null;
  size: number;
  mtimeMs: number;
  /** ◆ fluxplot / ✂ snip / 3D / video. */
  kindLabel: string;
  /** Where it is placed: figure (or slide) names; the active one flagged. */
  placements: { name: string; active: boolean }[];
  /** The plot's dissection key and file count (0 / "" = none, or not a project plot). */
  dissectKey: string;
  dissections: number;
  stats: InkStats | null;
  paper: string | null;
  fresh: boolean;
  /** The thumbnail already on screen — painted at once while the 1024 px one arrives. */
  placeholder: string;
}

export interface DissectionPeek {
  kind: "dissection";
  abs: string;
  stamp: string;
  name: string;
  group: string;
  aspect: number;
  physMm: [number, number] | null;
  mtimeMs: number;
  /** Tables: the first rows. */
  table: TablePreview | null;
  placeholder: string;
}

export type PeekContent = PlotPeek | DissectionPeek;

export interface PeekState {
  content: PeekContent;
  /** The tile it stands beside. */
  cell: HTMLElement;
}

const state = writable<PeekState | null>(null);
export const peekState = { subscribe: state.subscribe };

let timer: ReturnType<typeof setTimeout> | null = null;
let candidate: { make: () => PeekContent | null; cell: HTMLElement } | null = null;
let enabled = true;

/** The ⋯ "Peek on hover" preference (Shift+Space works either way). */
export function setPeekOnHover(on: boolean): void {
  enabled = on;
  if (!on) { cancelDwell(); }
}

function cancelDwell() {
  if (timer) { clearTimeout(timer); timer = null; }
  candidate = null;
}

function show(make: () => PeekContent | null, cell: HTMLElement) {
  const content = make();
  if (content && cell.isConnected) state.set({ content, cell });
  else state.set(null);
}

/**
 * The pointer is over a tile (`make` builds its content lazily), or over no tile (null). While a
 * Peek is up, a new tile replaces it at once; otherwise the dwell starts over.
 */
export function peekHover(make: (() => PeekContent | null) | null, cell: HTMLElement | null): void {
  if (!make || !cell) { cancelDwell(); return; }
  if (get(state)) { cancelDwell(); show(make, cell); return; }
  if (!enabled) return;
  cancelDwell();
  candidate = { make, cell };
  timer = setTimeout(() => {
    timer = null;
    const c = candidate;
    candidate = null;
    if (c) show(c.make, c.cell);
  }, PEEK_DWELL_MS);
}

/** Shift+Space: show the focused tile's Peek, or hide the one that is up. */
export function peekToggle(make: () => PeekContent | null, cell: HTMLElement | null): void {
  cancelDwell();
  if (get(state) || !cell) { state.set(null); return; }
  show(make, cell);
}

/** Hide now (pointer left the rail, scroll, a key, a press, a drag, the rail unmounting). */
export function hidePeek(): void {
  cancelDwell();
  if (get(state)) state.set(null);
}

/** Whether a Peek is showing (dev/test). */
export function peekShowing(): boolean {
  return !!get(state);
}
