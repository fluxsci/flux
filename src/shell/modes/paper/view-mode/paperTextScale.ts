// Paper TEXT SIZE — the pure core (no Svelte, no DOM), so the ladder/clamp/
// target arithmetic is gated hermetically (verify-paper-textscale.ts) and the
// store below it stays a thin persistence wrapper.
//
// The model: Paper has three panels, each carrying its OWN scale. A separate
// `targets` set says which of them the status-bar slider and the Ctrl+/−
// chords drive — "all together", "just one", or any combination, exactly as
// the scope popover presents it. Scale and target are deliberately
// independent: re-scoping the slider must never silently resize a panel.
//
// The scale is applied as `--ts-scale` on the panel's root element. Every
// --ts-* token in tokens.css multiplies through it, so the panel's real type
// changes size and RE-LAYS-OUT (line wrapping, the editor's 72ch measure,
// CodeMirror's line heights). This is deliberately NOT a transform: a scaled
// canvas would blur glyphs and keep the measure frozen at its 100% width.

export const PAPER_PANELS = ["editor", "sidebar", "margin"] as const;
export type PaperPanelId = (typeof PAPER_PANELS)[number];

export const PANEL_LABELS: Record<PaperPanelId, string> = {
  editor: "Manuscript",
  sidebar: "Left sidebar",
  margin: "Right margin",
};

export interface PaperTextScaleState {
  /** Per-panel multiplier of the authored type scale (1 = 100%). */
  scale: Record<PaperPanelId, number>;
  /** Which panels the slider and the Ctrl+/− chords act on. Never all-false. */
  targets: Record<PaperPanelId, boolean>;
}

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2.5;
/** Slider granularity — 5% notches, the same feel as Word's zoom slider. */
export const SCALE_SLIDER_STEP = 0.05;

/** The Ctrl+/− ladder (browser-zoom shaped: coarse at the ends, fine near 100%). */
export const SCALE_STEPS = [
  0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5,
] as const;

/** Float noise (0.7000000000000001) would show up in the readout and in the
 *  persisted JSON — every value that leaves this module is rounded here. */
export function roundScale(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return roundScale(Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)));
}

/** Percent readout — always an integer ("110%", never "110.00000001%"). */
export function scalePercent(n: number): number {
  return Math.round(clampScale(n) * 100);
}

/** Next rung of the ladder in `dir` (+1 bigger, −1 smaller); clamps at the ends.
 *  An off-ladder value (dragged to 1.03) steps to the next rung PAST it, so a
 *  slider drag followed by Ctrl+= never appears to move backwards. */
export function stepScale(current: number, dir: 1 | -1): number {
  const v = clampScale(current);
  const eps = 1e-6;
  if (dir > 0) {
    for (const s of SCALE_STEPS) if (s > v + eps) return roundScale(s);
    return roundScale(SCALE_MAX);
  }
  for (let i = SCALE_STEPS.length - 1; i >= 0; i--) {
    const s = SCALE_STEPS[i];
    if (s < v - eps) return roundScale(s);
  }
  return roundScale(SCALE_MIN);
}

export const DEFAULT_TEXT_SCALE: PaperTextScaleState = {
  scale: { editor: 1, sidebar: 1, margin: 1 },
  // The manuscript is what "text size" means while writing; the sidebar and
  // margin are opt-in through the scope popover (one click each).
  targets: { editor: true, sidebar: false, margin: false },
};

/** The panels the slider/chords drive. Never empty — see setTarget. */
export function targetPanels(s: PaperTextScaleState): PaperPanelId[] {
  const on = PAPER_PANELS.filter((p) => s.targets[p]);
  return on.length ? on : ["editor"];
}

/** What the slider and the readout show. Editor wins when it is in scope (it
 *  is the panel the user is looking at); otherwise the first target in panel
 *  order. */
export function representativeScale(s: PaperTextScaleState): number {
  const on = targetPanels(s);
  const primary = on.includes("editor") ? "editor" : on[0];
  return clampScale(s.scale[primary]);
}

/** True when the scoped panels disagree — the readout shows a "mixed" dot, and
 *  the next slider move harmonizes them. */
export function targetsMixed(s: PaperTextScaleState): boolean {
  const on = targetPanels(s);
  const first = clampScale(s.scale[on[0]]);
  return on.some((p) => clampScale(s.scale[p]) !== first);
}

/** Set every scoped panel to `value`. Panels out of scope keep their size. */
export function setScale(s: PaperTextScaleState, value: number): PaperTextScaleState {
  const v = clampScale(value);
  const scale = { ...s.scale };
  for (const p of targetPanels(s)) scale[p] = v;
  return { ...s, scale };
}

/** Step every scoped panel one rung. Mixed scopes harmonize onto the
 *  representative panel's next rung, so one chord always leaves them equal. */
export function stepTargets(s: PaperTextScaleState, dir: 1 | -1): PaperTextScaleState {
  return setScale(s, stepScale(representativeScale(s), dir));
}

export function resetTargets(s: PaperTextScaleState): PaperTextScaleState {
  return setScale(s, 1);
}

/** Toggle a panel in or out of scope. Emptying the scope is refused — a slider
 *  wired to nothing is a dead control, not a valid configuration. */
export function setTarget(
  s: PaperTextScaleState,
  panel: PaperPanelId,
  on: boolean,
): PaperTextScaleState {
  if (!on && PAPER_PANELS.filter((p) => s.targets[p]).length <= 1 && s.targets[panel]) return s;
  return { ...s, targets: { ...s.targets, [panel]: on } };
}

/** Scope every panel at once ("all panels together"). */
export function setAllTargets(s: PaperTextScaleState, on: boolean): PaperTextScaleState {
  if (!on) return s; // never empty the scope
  return { ...s, targets: { editor: true, sidebar: true, margin: true } };
}

export function allTargeted(s: PaperTextScaleState): boolean {
  return PAPER_PANELS.every((p) => s.targets[p]);
}

/** The class a scaled panel root must carry. It is what re-derives the whole
 *  --ts-* scale from the element's OWN --ts-scale (tokens.css explains why the
 *  class is required and inheritance alone is not enough). */
export const TEXT_SCALE_CLASS = "ts-scaled";

/** Inline style for a panel root, to be paired with TEXT_SCALE_CLASS. Returned
 *  as a string (not an object) because every consumer is a Svelte `style={…}`
 *  attribute. */
export function panelScaleStyle(scale: number): string {
  return `--ts-scale:${clampScale(scale)}`;
}

/** localStorage is untrusted input (hand-edited, older shape, another build).
 *  Anything unusable falls back to the default rather than throwing. */
export function normalizeTextScale(raw: unknown): PaperTextScaleState {
  const src = (raw ?? {}) as Partial<PaperTextScaleState>;
  const scale = { ...DEFAULT_TEXT_SCALE.scale };
  const targets = { ...DEFAULT_TEXT_SCALE.targets };
  for (const p of PAPER_PANELS) {
    const v = (src.scale as Record<string, unknown> | undefined)?.[p];
    if (typeof v === "number" && Number.isFinite(v)) scale[p] = clampScale(v);
    const t = (src.targets as Record<string, unknown> | undefined)?.[p];
    if (typeof t === "boolean") targets[p] = t;
  }
  if (!PAPER_PANELS.some((p) => targets[p])) targets.editor = true;
  return { scale, targets };
}
