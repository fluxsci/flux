import { writable } from "svelte/store";

export type FluxFigMenuSize = "sm" | "md" | "lg";
export type FluxFigMenuPos = "center" | "top" | "left" | "right";
export type FluxFigMenuAnim = "draw" | "fade"; // self-drawing line vs. quick fade

export interface Settings {
  fluxFigMenuSize: FluxFigMenuSize;
  fluxFigMenuPos: FluxFigMenuPos;
  fluxFigMenuAnim: FluxFigMenuAnim;
  fluxFigMenuOpacity: number; // 0.6 .. 1
  flexokiDefault: boolean; // ship the Flexoki palette in new projects
  // Feature 11 — rulers / guides / grid.
  showRulers: boolean; // H/V rulers along the canvas edges (Shift+R)
  showGrid: boolean; // faint background grid at `gridSize`
  gridSize: number; // world units
  snapGrid: boolean; // snap moves/resizes to the grid
  snapPixel: boolean; // round committed coords to whole pixels (crisp export)
  // Paper — the dynamic margin.
  paperMarginScene: "harmonograph" | "neurons" | "inkwind" | "loom" | "vines";
  paperMaxMarginPanes: number; // max dynamic panes open at once
  paperCleanMargin: boolean; // close all panes whenever focus returns to the editor
  paperCaretMs: number; // caret glide duration in ms (0 = instant). 70 = the tuned "smooth caret".
  // App — updates.
  updateCheck: boolean; // check GitHub releases for a newer version (packaged app only)
}

const KEY = "flux.settings";
const DEFAULTS: Settings = {
  fluxFigMenuSize: "md",
  fluxFigMenuPos: "center",
  fluxFigMenuAnim: "draw",
  fluxFigMenuOpacity: 0.94,
  flexokiDefault: true,
  showRulers: false,
  showGrid: false,
  gridSize: 8,
  snapGrid: false,
  snapPixel: false,
  paperMarginScene: "harmonograph",
  paperMaxMarginPanes: 4,
  paperCleanMargin: false,
  paperCaretMs: 70,
  updateCheck: true,
};

// Migrate legacy "forgery*" keys (the FluxFig Menu was formerly "The Forgery", M6)
// to the current "fluxFigMenu*" keys, so persisted preferences survive the rename.
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const renames: Record<string, keyof Settings> = {
    forgerySize: "fluxFigMenuSize",
    forgeryPos: "fluxFigMenuPos",
    forgeryAnim: "fluxFigMenuAnim",
    forgeryOpacity: "fluxFigMenuOpacity",
  };
  for (const [legacy, current] of Object.entries(renames)) {
    if (legacy in out && !(current in out)) out[current] = out[legacy];
    delete out[legacy];
  }
  return out;
}

function load(): Settings {
  try {
    return { ...DEFAULTS, ...migrate(JSON.parse(localStorage.getItem(KEY) || "{}")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = writable<Settings>(load());
settings.subscribe((v) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {}
});

// Transient UI state.
export const settingsOpen = writable(false);
export const fluxFigMenuOpen = writable(false);
export const helpOpen = writable(false); // shell-global keyboard-shortcut reference
