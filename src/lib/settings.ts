import { decodePreferences } from "./preferences";
import { writable } from "svelte/store";

// Paper caret motion model (src/shell/modes/paper/editing/caretFeel.ts):
// "chase" = exponential pursuit (default); "smooth" = fixed-duration
// monkeytype-style tween. Owner decision 2026-07-21 out of the caret-feel lab
// (classic CSS glide and chase-trail were cut; soft blink is built-in).
export type PaperCaretFeel = "chase" | "smooth";
export type CorrectionProvider = "flux" | "ollama" | "openai";
export type CorrectionDialect = "american" | "british" | "canadian" | "australian";
export type CorrectionAggressiveness = "standard" | "aggressive" | "really-aggressive";

export interface Settings {
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
  // Figure — the caption editor (Alt+C).
  captionFontSize: number; // caption body size in WORLD px (scales with canvas zoom)
  // Paper — the dynamic margin.
  paperMarginScene: "harmonograph" | "neurons" | "inkwind" | "loom" | "vines";
  paperMaxMarginPanes: number; // max dynamic panes open at once
  paperCleanMargin: boolean; // close all panes whenever focus returns to the editor
  paperCaretFeel: PaperCaretFeel; // caret motion model — chase (default) | smooth
  paperLocalCorrections: boolean; // private on-device typo + spacing correction
  paperContextualCorrections: boolean; // sentence-level candidate adjudication
  paperCorrectionProvider: CorrectionProvider;
  paperCorrectionModel: string;
  paperCorrectionDialect: CorrectionDialect;
  paperCorrectionAggressiveness: CorrectionAggressiveness;
  paperCorrectionGuidance: string;
  // App — updates.
  updateCheck: boolean; // check GitHub releases for a newer version (packaged app only)
}

const KEY = "flux.settings";
const DEFAULTS: Settings = {
  flexokiDefault: true,
  paletteCollection: "flexoki",
  colormapCollection: "mpl",
  showRulers: false,
  showGrid: false,
  gridSize: 8,
  snapGrid: false,
  snapPixel: false,
  captionFontSize: 13,
  paperMarginScene: "inkwind",
  paperMaxMarginPanes: 4,
  paperCleanMargin: false,
  paperCaretFeel: "chase",
  paperLocalCorrections: true,
  paperContextualCorrections: true,
  paperCorrectionProvider: "flux",
  paperCorrectionModel: "qwen3-4b-q4_k_m",
  paperCorrectionDialect: "american",
  paperCorrectionAggressiveness: "standard",
  paperCorrectionGuidance: "Preserve scientific terminology, identifiers, and capitalization.",
  updateCheck: true,
};

// Migrate persisted preferences forward. The property menu (once "The
// Forgery", then the docked FluxFig Menu) had size / position / nudge / opacity
// / entrance / X-ray-dock settings; since the 2026-09-15 surface redesign both
// panels anchor themselves beside the selection and open instantly, so every
// one of those keys — legacy "forgery*" spellings included — is simply dropped.
const RETIRED_KEYS = [
  "forgerySize", "forgeryPos", "forgeryAnim", "forgeryOpacity",
  "fluxFigMenuSize", "fluxFigMenuPos", "fluxFigMenuDx", "fluxFigMenuDy",
  "fluxFigMenuAnim", "fluxFigMenuOpacity", "xrayPos", "xrayDx", "xrayDy",
];
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of RETIRED_KEYS) delete out[k];
  // caret-feel (2026-07-21): the lab collapsed to chase|smooth — "monkeytype"
  // was renamed "smooth"; "classic"/"chase-trail" and the soft-blink /
  // line-scroll / glide-ms settings were retired (soft blink is built-in).
  if (out.paperCaretFeel === "monkeytype") out.paperCaretFeel = "smooth";
  else if (out.paperCaretFeel !== "smooth" && out.paperCaretFeel !== "chase") delete out.paperCaretFeel;
  delete out.paperCaretMs;
  delete out.paperCaretSoftBlink;
  delete out.paperSmoothLineScroll;
  if (typeof out.paperLocalCorrections !== "boolean") delete out.paperLocalCorrections;
  if (typeof out.paperContextualCorrections !== "boolean") delete out.paperContextualCorrections;
  if (out.paperCorrectionProvider !== "flux" && out.paperCorrectionProvider !== "ollama" && out.paperCorrectionProvider !== "openai") delete out.paperCorrectionProvider;
  if (typeof out.paperCorrectionModel !== "string" || out.paperCorrectionModel.length > 120) delete out.paperCorrectionModel;
  if (!["american", "british", "canadian", "australian"].includes(String(out.paperCorrectionDialect))) delete out.paperCorrectionDialect;
  if (!["standard", "aggressive", "really-aggressive"].includes(String(out.paperCorrectionAggressiveness))) delete out.paperCorrectionAggressiveness;
  if (typeof out.paperCorrectionGuidance !== "string" || out.paperCorrectionGuidance.length > 500) delete out.paperCorrectionGuidance;
  return out;
}

export function decodeSettings(value: unknown): Settings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return decodePreferences(migrate(raw), DEFAULTS, {
    gridSize: { min: 1 }, captionFontSize: { min: 9, max: 28 }, paperMaxMarginPanes: { min: 1, max: 6 },
    paletteCollection: { enum: ["flexoki", "brewer", "tol", "project"] }, colormapCollection: { enum: ["mpl", "crameri", "tol", "cmasher"] },
    paperMarginScene: { enum: ["harmonograph", "neurons", "inkwind", "loom", "vines"] },
    paperCaretFeel: { enum: ["chase", "smooth"] }, paperCorrectionProvider: { enum: ["flux", "ollama", "openai"] },
    paperCorrectionDialect: { enum: ["american", "british", "canadian", "australian"] },
    paperCorrectionAggressiveness: { enum: ["standard", "aggressive", "really-aggressive"] },
    paperCorrectionModel: { maxLength: 120 }, paperCorrectionGuidance: { maxLength: 500 },
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
/** A shell surface (Note to agent, Snapshot & annotate) owns the keyboard: the
 *  editor's single-letter tools must not fire while a note is being typed. */
export const shellModalOpen = writable(false);
