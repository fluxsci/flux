import { writable } from "svelte/store";

export type FluxFigMenuSize = "sm" | "md" | "lg";
export type FluxFigMenuPos = "center" | "top" | "left" | "right"; // "top" is legacy → treated as center
export type FluxFigMenuAnim = "draw" | "fade"; // self-drawing line vs. quick fade
export type XrayPos = "above" | "below"; // which side of the FluxFig menu the X-ray docks to

export interface Settings {
  fluxFigMenuSize: FluxFigMenuSize;
  fluxFigMenuPos: FluxFigMenuPos;
  fluxFigMenuDx: number; // px nudge from the preset position (+ = right)
  fluxFigMenuDy: number; // px nudge from the preset position (+ = down)
  fluxFigMenuAnim: FluxFigMenuAnim;
  fluxFigMenuOpacity: number; // 0.6 .. 1
  xrayPos: XrayPos; // the X-ray docks above/below the FluxFig menu's spot
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
  fluxFigMenuDx: 0,
  fluxFigMenuDy: 0,
  fluxFigMenuAnim: "draw",
  fluxFigMenuOpacity: 0.94,
  xrayPos: "above",
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
  // figure-v1: the X-ray docks above/below the FluxFig menu now (it briefly had
  // its own preset + nudge), and the "top" menu preset folded into "center"
  // (vertical placement is the Y-nudge's job).
  if (out.xrayPos !== "above" && out.xrayPos !== "below") delete out.xrayPos;
  delete out.xrayDx;
  delete out.xrayDy;
  if (out.fluxFigMenuPos === "top") out.fluxFigMenuPos = "center";
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

// Right-rail (Inspector) visibility — Ctrl+Shift+B in the figure editor, and
// (because the slide editor IS the figure editor) the whole slide right rail.
// A workspace toggle, not a preference, so it keeps its own key.
const INSPECTOR_KEY = "flux.ui.inspectorHidden";
export const inspectorHidden = writable<boolean>(
  (() => {
    try {
      return localStorage.getItem(INSPECTOR_KEY) === "1";
    } catch {
      return false;
    }
  })(),
);
inspectorHidden.subscribe((v) => {
  try {
    localStorage.setItem(INSPECTOR_KEY, v ? "1" : "0");
  } catch {}
});

// ---------------------------------------------------------------------------
// Popup layout: the FluxFig menu is placed by preset (horizontal) + px nudge,
// and the X-ray docks to it across a fixed horizontal boundary line (above by
// default). Growth is deterministic — each panel expands AWAY from the
// boundary (X-ray above grows upward, the menu grows downward) — so a
// user-tuned position never shifts as content expands. Both panels consume
// this one helper; keep them in lockstep.
export const FLUXFIG_WIDTHS: Record<FluxFigMenuSize, number> = { sm: 420, md: 560, lg: 720 };
const POPUP_GAP = 6; // px each panel keeps from the boundary line

export function popupLayout(s: Settings): {
  width: number; // shared panel width (px)
  menuWrap: string; // style for the FluxFig menu's fixed full-screen wrapper
  menuMax: string; // max-height for the menu panel
  xrayWrap: string; // style for the X-ray's fixed full-screen wrapper
  xrayMax: string; // max-height for the X-ray panel
} {
  const dx = s.fluxFigMenuDx || 0;
  const dy = s.fluxFigMenuDy || 0;
  const width = FLUXFIG_WIDTHS[s.fluxFigMenuSize];
  const xAlign =
    s.fluxFigMenuPos === "left"
      ? "justify-content:flex-start; padding-left:28px;"
      : s.fluxFigMenuPos === "right"
        ? "justify-content:flex-end; padding-right:28px;"
        : "justify-content:center;";
  // The boundary line the two panels stack around (a CSS length expression).
  const A = `calc(50vh + ${dy}px)`;
  const shift = ` transform:translate3d(${dx}px, 0, 0);`;
  const below = `align-items:flex-start; padding-top:max(8px, calc(${A} + ${POPUP_GAP}px));`;
  const above = `align-items:flex-end; padding-bottom:max(8px, calc(100vh - ${A} + ${POPUP_GAP}px));`;
  const belowMax = `calc(100vh - ${A} - ${POPUP_GAP + 8}px)`;
  const aboveMax = `calc(${A} - ${POPUP_GAP + 8}px)`;
  const xrayAbove = s.xrayPos !== "below";
  return {
    width,
    menuWrap: xAlign + (xrayAbove ? below : above) + shift,
    menuMax: `min(78vh, ${xrayAbove ? belowMax : aboveMax})`,
    xrayWrap: xAlign + (xrayAbove ? above : below) + shift,
    xrayMax: `min(82vh, ${xrayAbove ? aboveMax : belowMax})`,
  };
}

// Transient UI state.
export const settingsOpen = writable(false);
export const fluxFigMenuOpen = writable(false);
export const helpOpen = writable(false); // shell-global keyboard-shortcut reference
