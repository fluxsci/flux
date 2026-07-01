// ---------------------------------------------------------------------------
// Flux Slide — built-in themes + theme resolution.
//
// Themes carry CONCRETE values (Flexoki hex + real font stacks), never app-only
// CSS vars, so the exported offline HTML renders identically (D2: one renderer,
// two hosts). The stage applies a resolved theme as scoped CSS custom properties
// (`--sl-bg`, `--sl-text`, `--sl-accent`, `--sl-font-*`) that elements default
// to. Flexoki dark is the default; a light theme and user `theme.json` files
// (reusable across decks) round out the small set the plan sanctions (D7/D11).
// ---------------------------------------------------------------------------

import type { DeckTheme } from "./types";

// The house serif/mono stacks (mirror src/styles/tokens.css --font-serif/-mono).
// Gelasio is bundled (metric-compatible with Georgia) and embedded on export.
const SERIF = 'Georgia, "Gelasio", "Times New Roman", Times, serif';
const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

/** Flexoki dark — the default. Single blue accent; serif content. */
export const FLUX_DARK: DeckTheme = {
  id: "flux-dark",
  name: "Flux Dark",
  background: "#100f0f", // flx-black
  surface: "#1c1b1a", // base-950
  text: "#cecdc3", // base-200
  textHi: "#fffcf0", // paper
  textMuted: "#878580", // base-500
  accent: "#4385be", // blue-400
  accentBright: "#66a0c8", // blue-300
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

/** Flexoki light — cream desk, ink text. Accent darkens to a text-grade blue so
 *  it stays AA-legible on cream (mirrors the app's light-mode accent shift). */
export const FLUX_LIGHT: DeckTheme = {
  id: "flux-light",
  name: "Flux Light",
  background: "#fffcf0", // paper
  surface: "#f2f0e5", // base-50
  text: "#100f0f", // black
  textHi: "#100f0f",
  textMuted: "#6f6e69", // base-600
  accent: "#205ea6", // blue-600 (text-grade)
  accentBright: "#4385be", // blue-400
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

/** Deep navy, cyan accent — a calm, high-contrast dark for a big auditorium. */
export const FLUX_MIDNIGHT: DeckTheme = {
  id: "flux-midnight",
  name: "Flux Midnight",
  background: "#0b1220",
  surface: "#141d2e",
  text: "#c8d2e0",
  textHi: "#f4f8ff",
  textMuted: "#7c8798",
  accent: "#4fb3c4",
  accentBright: "#7fd4e3",
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

/** Neutral slate, warm amber accent — restrained, editorial. */
export const FLUX_SLATE: DeckTheme = {
  id: "flux-slate",
  name: "Flux Slate",
  background: "#1a1a1c",
  surface: "#262629",
  text: "#d2d0cb",
  textHi: "#fbfaf7",
  textMuted: "#8b8985",
  accent: "#d0a215", // amber-ish, warm on cool slate
  accentBright: "#eab308",
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

/** Warm parchment, sienna accent — an academic "paper" look, easy on the eyes. */
export const FLUX_SEPIA: DeckTheme = {
  id: "flux-sepia",
  name: "Flux Sepia",
  background: "#f4ecd8",
  surface: "#eadfc4",
  text: "#3b2f22",
  textHi: "#241c12",
  textMuted: "#7a6a54",
  accent: "#9c4a21", // sienna
  accentBright: "#bc6428",
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

/** Maximum contrast — pure black, bright text, vivid accent. Reads from the back
 *  row in a bright room where subtler darks wash out. */
export const FLUX_CONTRAST: DeckTheme = {
  id: "flux-contrast",
  name: "Flux Contrast",
  background: "#000000",
  surface: "#141414",
  text: "#f2f2f2",
  textHi: "#ffffff",
  textMuted: "#a8a8a8",
  accent: "#4cc2ff",
  accentBright: "#8ad8ff",
  fontTitle: SERIF,
  fontBody: SERIF,
  fontMono: MONO,
};

export const BUILTIN_THEMES: Record<string, DeckTheme> = {
  "flux-dark": FLUX_DARK,
  "flux-light": FLUX_LIGHT,
  "flux-midnight": FLUX_MIDNIGHT,
  "flux-slate": FLUX_SLATE,
  "flux-sepia": FLUX_SEPIA,
  "flux-contrast": FLUX_CONTRAST,
};

export const DEFAULT_THEME_ID = "flux-dark";

/** Resolve a deck's `theme` field to a concrete `DeckTheme`. A built-in id maps
 *  directly; an unknown id (or a `./theme.json` reference whose object the
 *  caller already loaded and passes via `custom`) falls back to the default,
 *  with any provided custom fields layered on top. */
export function resolveTheme(
  themeRef: string | undefined,
  custom?: Partial<DeckTheme>,
): DeckTheme {
  const base = (themeRef && BUILTIN_THEMES[themeRef]) || FLUX_DARK;
  if (!custom) return base;
  return { ...base, ...custom };
}

/** Emit a resolved theme as `--sl-*` CSS custom-property declarations (the
 *  string goes into a `style="…"` on the stage root). Shared by the in-app
 *  stage and the exported HTML so they paint identically. */
export function themeCssVars(t: DeckTheme): string {
  return [
    `--sl-bg:${t.background}`,
    `--sl-surface:${t.surface}`,
    `--sl-text:${t.text}`,
    `--sl-text-hi:${t.textHi}`,
    `--sl-text-muted:${t.textMuted}`,
    `--sl-accent:${t.accent}`,
    `--sl-accent-bright:${t.accentBright}`,
    `--sl-font-title:${t.fontTitle}`,
    `--sl-font-body:${t.fontBody}`,
    `--sl-font-mono:${t.fontMono}`,
  ].join(";");
}
