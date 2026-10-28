import { decodePreferences } from "./preferences";
import { DEFAULT_PHYSICAL_UNIT, PHYSICAL_UNITS, type PhysicalUnit } from "./figure/physicalUnits";
import { writable } from "svelte/store";
import { DEFAULT_PLOT_SEARCH_SCOPE, PLOT_SEARCH_SCOPE_IDS, type PlotSearchScope } from "./plot/galleryScope";
import {
  ARROW_OUTLINE_RANGE, ARROW_ROUNDING_RANGE, ARROW_SHADOW_RANGE, ARROW_SIZE_RANGE, ARROW_TILT_RANGE,
  CURSOR_PRESS_DEFAULTS, CURSOR_PRESS_DEPTH_RANGE, CURSOR_PRESS_RETURN_RANGE,
  CURSOR_CENTRES, CURSOR_DEFAULTS, CURSOR_GAP_RANGE, CURSOR_HALO_OPACITY_RANGE, CURSOR_HALO_WIDTH_RANGE, CURSOR_PRESETS, CURSOR_RESIZE_STYLES,
  CURSOR_SIZE_RANGE, CURSOR_STROKE_RANGE, CURSOR_STYLES, cursorHex, type CursorCentre, type CursorResizeStyle, type CursorStyle,
} from "./cursor/cursorFamily";

export type CorrectionDialect = "american" | "british" | "canadian" | "australian";

export interface Settings {
  allowAgentView: boolean;
  "annotate.attachView": boolean;
  flexokiDefault: boolean; // ship the Flexoki palette in new projects
  // Colour pickers (2026-09-16): which collection opens first.
  paletteCollection: string; // "flexoki" | "brewer" | "tol" | "project"
  colormapCollection: string; // "mpl" | "crameri" | "tol" | "cmasher"
  // Feature 11 — rulers / guides / grid.
  showRulers: boolean; // H/V rulers along the canvas edges (Shift+R)
  showGrid: boolean; // faint background grid at `gridSize`
  gridSize: number; // world units
  snapGrid: boolean; // snap moves/resizes to the grid
  snapPixel: boolean; // round committed coords to whole pixels (crisp export)
  // WP 3.2: a line end released on a shape (drawn or dragged) sticks to it: a connector that follows the shape
  connectorsStick: boolean;
  // WP 4.1: in Present (and exported decks) Back plays the step in reverse instead of cutting to the step before
  slideBackAnimates: boolean;
  // Figure — the caption editor (Alt+C).
  captionFontSize: number; // Figure-Meta caption typing size in screen px
  // Figure — what a Plot gallery (Alt+G) search reaches (plot/galleryScope.ts).
  plotSearchScope: PlotSearchScope; // "current" | "folder" | "project" | "global" | "all"
  // Figure — the Plot gallery's Folders sidebar: a click on a folder row also expands /
  // collapses it (default off: the click shows the folder, the › arrow expands it).
  galleryFolderClickExpands: boolean;
  // Physical sizes (the Inspector's readouts, the Plots rail's Peek): inches by default —
  // matplotlib's figsize — or millimetres (figure/physicalUnits.ts).
  physicalUnit: PhysicalUnit;
  // The crosshair cursor family (2026-10-21, cursor/cursorFamily.ts): the one
  // drawing every pointer state is generated from. Defaults reproduce the
  // 2026-09-15 cursors byte for byte; cursorTheme.ts writes :root when they differ.
  cursorStyle: CursorStyle; // classic (Figma's arrow, the default) | crosshair
  arrowSize: number; // classic arrow height in px (16–23)
  arrowFill: string; // classic arrow fill (6-digit hex)
  arrowOutline: string; // classic arrow outline colour
  arrowOutlineWidth: number; // outline width each side (0–2.5)
  arrowRounding: number; // corner rounding radius (0–3)
  arrowShadow: number; // drop-shadow amount (0–1)
  arrowTilt: number; // extra rotation about the tip, degrees (−30–30)
  cursorPressEnabled: boolean; // tip-led classic arrow click feedback
  cursorPressDepth: number; // travel and shadow compression (0.25–1.5)
  cursorPressReturnMs: number; // release duration (60–200 ms); press is 45% of this
  cursorSize: number; // crosshair size in px (20–32, even); hotspot = size/2
  cursorStroke: number; // crosshair stroke width (0.8–3)
  cursorAdaptive: boolean; // the mark's colour follows the surface (dark ink on paper, light on dark)
  cursorCoreColor: string; // crosshair colour over light surfaces (6-digit hex)
  cursorCoreColorDark: string; // crosshair colour over dark surfaces (used when adaptive)
  cursorHaloWidth: number; // halo stroke width (0–6; 0 = no halo)
  cursorHaloColor: string; // halo colour
  cursorHaloOpacity: number; // halo opacity (0.2–1)
  cursorDotColor: string; // the accent dot and the duplicate badge
  cursorGap: number; // centre gap radius (0–6)
  cursorCentre: CursorCentre; // none | dot | ring at rest
  cursorHoverDot: boolean; // the accent dot over anything selectable
  cursorPressContract: boolean; // a press pulls the arms in
  cursorResizeStyle: CursorResizeStyle; // resize/rotate/move drawn in the family, or the OS cursors
  // Paper — the dynamic margin.
  paperMarginScene: "harmonograph" | "neurons" | "inkwind" | "loom" | "vines";
  paperMaxMarginPanes: number; // max dynamic panes open at once
  paperCleanMargin: boolean; // close all panes whenever focus returns to the editor
  paperLocalCorrections: boolean; // private on-device typo + spacing correction
  paperCorrectionDialect: CorrectionDialect;
  // App — updates.
  updateCheck: boolean; // check GitHub releases for a newer version (packaged app only)
}

const KEY = "flux.settings";
const DEFAULTS: Settings = {
  allowAgentView: true,
  "annotate.attachView": true,
  flexokiDefault: true,
  paletteCollection: "flexoki",
  colormapCollection: "mpl",
  showRulers: false,
  showGrid: false,
  gridSize: 8,
  snapGrid: false,
  snapPixel: false,
  connectorsStick: true,
  slideBackAnimates: true,
  captionFontSize: 16,
  plotSearchScope: DEFAULT_PLOT_SEARCH_SCOPE,
  galleryFolderClickExpands: false,
  physicalUnit: DEFAULT_PHYSICAL_UNIT,
  cursorStyle: CURSOR_DEFAULTS.style,
  arrowSize: CURSOR_DEFAULTS.arrowSize,
  arrowFill: CURSOR_DEFAULTS.arrowFill,
  arrowOutline: CURSOR_DEFAULTS.arrowOutline,
  arrowOutlineWidth: CURSOR_DEFAULTS.arrowOutlineWidth,
  arrowRounding: CURSOR_DEFAULTS.arrowRounding,
  arrowShadow: CURSOR_DEFAULTS.arrowShadow,
  arrowTilt: CURSOR_DEFAULTS.arrowTilt,
  cursorPressEnabled: CURSOR_PRESS_DEFAULTS.enabled,
  cursorPressDepth: CURSOR_PRESS_DEFAULTS.depth,
  cursorPressReturnMs: CURSOR_PRESS_DEFAULTS.returnMs,
  cursorSize: CURSOR_DEFAULTS.size,
  cursorStroke: CURSOR_DEFAULTS.stroke,
  cursorAdaptive: true,
  cursorCoreColor: CURSOR_DEFAULTS.coreColor,
  cursorCoreColorDark: CURSOR_DEFAULTS.coreColorDark,
  cursorHaloWidth: CURSOR_DEFAULTS.haloWidth,
  cursorHaloColor: CURSOR_DEFAULTS.haloColor,
  cursorHaloOpacity: CURSOR_DEFAULTS.haloOpacity,
  cursorDotColor: CURSOR_DEFAULTS.dotColor,
  cursorGap: CURSOR_DEFAULTS.gap,
  cursorCentre: CURSOR_DEFAULTS.centre,
  cursorHoverDot: CURSOR_DEFAULTS.hoverDot,
  cursorPressContract: CURSOR_DEFAULTS.pressContract,
  cursorResizeStyle: CURSOR_DEFAULTS.resizeStyle,
  paperMarginScene: "inkwind",
  paperMaxMarginPanes: 4,
  paperCleanMargin: false,
  paperLocalCorrections: true,
  paperCorrectionDialect: "american",
  updateCheck: true,
};

// Migrate persisted preferences forward. The property menu (once "The
// Forgery", then the docked FluxFig Menu) had size / position / nudge / opacity
// / entrance / X-ray-dock settings; since the 2026-09-15 surface redesign both
// panels anchor themselves beside the selection and open instantly, so every
// one of those keys — legacy "forgery*" spellings included — is simply dropped,
// as are retired Paper caret and correction preferences.
const RETIRED_KEYS = [
  "forgerySize", "forgeryPos", "forgeryAnim", "forgeryOpacity",
  "fluxFigMenuSize", "fluxFigMenuPos", "fluxFigMenuDx", "fluxFigMenuDy",
  "fluxFigMenuAnim", "fluxFigMenuOpacity", "xrayPos", "xrayDx", "xrayDy",
  "paperCaretFeel", "paperCaretMs", "paperCaretSoftBlink", "paperSmoothLineScroll",
  "paperContextualCorrections", "paperCorrectionProvider", "paperCorrectionModel",
  "paperCorrectionAggressiveness", "paperCorrectionGuidance",
];
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of RETIRED_KEYS) delete out[k];
  if (typeof out.paperLocalCorrections !== "boolean") delete out.paperLocalCorrections;
  if (!["american", "british", "canadian", "australian"].includes(String(out.paperCorrectionDialect))) delete out.paperCorrectionDialect;
  // Cursor (2026-10-21, same day): the first cut had a colour SCHEME and a halo
  // ENUM; the owner asked for the colours and widths directly. Translate the
  // short-lived keys so a worktree build's settings carry over, then drop them.
  if (typeof out.cursorScheme === "string") {
    // the first cut's ink/paper/accent schemes: outlined looks, one colour everywhere
    const c = out.cursorScheme === "paper" ? { core: "#ffffff", halo: "#151515", op: 0.85 } : out.cursorScheme === "accent" ? { core: "#4385be", halo: "#ffffff", op: 0.92 } : { core: "#151515", halo: "#ffffff", op: 0.92 };
    if (out.cursorCoreColor === undefined) out.cursorCoreColor = c.core;
    if (out.cursorCoreColorDark === undefined) out.cursorCoreColorDark = c.core;
    if (out.cursorAdaptive === undefined) out.cursorAdaptive = false;
    if (out.cursorHaloColor === undefined) out.cursorHaloColor = c.halo;
    if (out.cursorHaloOpacity === undefined) out.cursorHaloOpacity = c.op;
  }
  if (typeof out.cursorHalo === "string" && out.cursorHaloWidth === undefined) {
    const st = typeof out.cursorStroke === "number" ? out.cursorStroke : CURSOR_DEFAULTS.stroke;
    out.cursorHaloWidth = out.cursorHalo === "off" ? 0 : out.cursorHalo === "thin" ? Math.round((st + 1.0) * 10) / 10 : Math.round((st + 1.9) * 10) / 10;
  }
  delete out.cursorScheme;
  delete out.cursorHalo;
  if (out.cursorCoreColor !== undefined) out.cursorCoreColor = cursorHex(out.cursorCoreColor, CURSOR_DEFAULTS.coreColor);
  if (out.cursorCoreColorDark !== undefined) out.cursorCoreColorDark = cursorHex(out.cursorCoreColorDark, CURSOR_DEFAULTS.coreColorDark);
  if (out.arrowFill !== undefined) out.arrowFill = cursorHex(out.arrowFill, CURSOR_DEFAULTS.arrowFill);
  if (out.arrowOutline !== undefined) out.arrowOutline = cursorHex(out.arrowOutline, CURSOR_DEFAULTS.arrowOutline);
  if (out.cursorHaloColor !== undefined) out.cursorHaloColor = cursorHex(out.cursorHaloColor, CURSOR_DEFAULTS.haloColor);
  if (out.cursorDotColor !== undefined) out.cursorDotColor = cursorHex(out.cursorDotColor, CURSOR_DEFAULTS.dotColor);
  return out;
}

export function decodeSettings(value: unknown): Settings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return decodePreferences(migrate(raw), DEFAULTS, {
    gridSize: { min: 1 }, captionFontSize: { min: 9, max: 28 }, paperMaxMarginPanes: { min: 1, max: 6 },
    paletteCollection: { enum: ["flexoki", "brewer", "tol", "project"] }, colormapCollection: { enum: ["mpl", "crameri", "tol", "cmasher"] },
    paperMarginScene: { enum: ["harmonograph", "neurons", "inkwind", "loom", "vines"] },
    plotSearchScope: { enum: PLOT_SEARCH_SCOPE_IDS }, physicalUnit: { enum: PHYSICAL_UNITS },
    cursorSize: { ...CURSOR_SIZE_RANGE }, cursorStroke: { ...CURSOR_STROKE_RANGE }, cursorGap: { ...CURSOR_GAP_RANGE },
    cursorHaloWidth: { ...CURSOR_HALO_WIDTH_RANGE }, cursorHaloOpacity: { ...CURSOR_HALO_OPACITY_RANGE },
    cursorCoreColor: { maxLength: 7 }, cursorCoreColorDark: { maxLength: 7 }, cursorHaloColor: { maxLength: 7 }, cursorDotColor: { maxLength: 7 },
    cursorStyle: { enum: CURSOR_STYLES }, arrowSize: { ...ARROW_SIZE_RANGE }, arrowFill: { maxLength: 7 }, arrowOutline: { maxLength: 7 },
    arrowOutlineWidth: { ...ARROW_OUTLINE_RANGE }, arrowRounding: { ...ARROW_ROUNDING_RANGE }, arrowShadow: { ...ARROW_SHADOW_RANGE }, arrowTilt: { ...ARROW_TILT_RANGE },
    cursorPressDepth: { ...CURSOR_PRESS_DEPTH_RANGE }, cursorPressReturnMs: { ...CURSOR_PRESS_RETURN_RANGE },
    cursorCentre: { enum: CURSOR_CENTRES }, cursorResizeStyle: { enum: CURSOR_RESIZE_STYLES },
    paperCorrectionDialect: { enum: ["american", "british", "canadian", "australian"] },
  });
}

function load(): Settings {
  try {
    return decodeSettings(JSON.parse(localStorage.getItem(KEY) || "{}"));
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

// Left-rail visibility — Ctrl+B (when no text is selected) hides the figure
// sidebar, and (same sharing rule as inspectorHidden) the slide filmstrip.
// Visibility is a boolean, never a zero width: rail widths keep their value
// across hide/show (figureLayoutStore / slideLayoutStore).
const LEFTRAIL_KEY = "flux.ui.leftRailHidden";
export const leftRailHidden = writable<boolean>(
  (() => {
    try {
      return localStorage.getItem(LEFTRAIL_KEY) === "1";
    } catch {
      return false;
    }
  })(),
);
leftRailHidden.subscribe((v) => {
  try {
    localStorage.setItem(LEFTRAIL_KEY, v ? "1" : "0");
  } catch {}
});

// Transient UI state.
export const settingsOpen = writable(false);
export const fluxFigMenuOpen = writable(false);
export const helpOpen = writable(false); // shell-global keyboard-shortcut reference
/** A shell surface (Annotate, Figure-Meta) owns the keyboard: the
 *  editor's single-letter tools must not fire while a note is being typed. */
export const shellModalOpen = writable(false);
