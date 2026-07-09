// ---------------------------------------------------------------------------
// Flux Slide — the deck data model (the standard, designed before the UI).
//
// A deck is a plain, diffable `slides/<deckId>/deck.json` (the source of truth)
// plus a deck-local `assets/` dir and an optional `theme.json`. A human and an
// agent author the *same* file (Flux's "the file is the API"). Keep this shape
// JSON-friendly (no class instances, functions, or DOM) so the on-disk format
// stays open and inspectable, exactly like `src/lib/types.ts`.
//
// The element model reuses the figure `Element` union verbatim (so a plot
// dropped on a slide is the same animation-ready `SemanticPlotElement`) and adds
// four slide-only types that extend `ElementBase`. The beat/track model is the
// build timeline: a beat is one "advance" step; a track is one animation within
// it. The track shape is forward-compatible with full per-property keyframing
// (§4.3 of the plan) — `keyframes[]` is purely additive, no migration.
//
// See: notes/ plan §4 (deck.json), §5 (the player/preset/morph), §4.3 (keyframes).
// ---------------------------------------------------------------------------

import type { Element, ElementBase, Id } from "../types";

export const DECK_SCHEMA_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/** Authoring resolution of the stage (16:9 by default). The player auto-scales
 *  this fixed canvas to any screen (letterboxed), so a deck authored at 1280×720
 *  fills any projector. */
export interface StageSize {
  width: number;
  height: number;
}

/** Slide-to-slide transitions (kept deliberately small — D7 holds the line on a
 *  big transition library). */
export type TransitionKind = "none" | "fade" | "slide" | "push";

/** Named easings — map onto `src/lib/motion/tokens.ts` EASE + smoothEasing().
 *  "smooth" is manim's 5th-order smoothstep, reserved for signature motion. */
export type EasingToken = "smooth" | "standard" | "enter" | "exit" | "linear";

/** After Effects-style velocity profile: outgoing/incoming influence, 0–100%. */
export interface Influence {
  /** Incoming influence — slow-in at the END (0 = abrupt stop, 100 = long glide). */
  in: number;
  /** Outgoing influence — slow-out at the START (0 = abrupt start, 100 = long ease-in). */
  out: number;
}

/** How the presenter reaches a beat (§4.2). `click` = a manual advance (the
 *  default "thing" you step to); `with-prev` chains onto the previous beat's
 *  click so several tracks land on one press; `auto` plays automatically
 *  `autoDelayMs` after the previous beat finishes. */
export type AdvanceMode = "click" | "with-prev" | "auto";

export interface DeckDefaults {
  transition: TransitionKind;
  buildEasing: EasingToken;
  advance: AdvanceMode;
}

/** Deck-local imported media NOT owned by the project (screenshots, a video).
 *  Stored under `slides/<deckId>/assets/` and referenced by stable id. */
export interface DeckAsset {
  id: Id;
  kind: "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "mp4" | "webm" | "mov";
  /** Deck-relative path, e.g. "assets/paper-fig2.png". */
  path: string;
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface Deck {
  schemaVersion: string;
  id: Id;
  title: string;
  created: string;
  modified: string;
  /** Authoring resolution; 16:9 default (also 1920×1080, 4:3). */
  stage: StageSize;
  /** Built-in theme id (e.g. "flux-dark") OR "./theme.json". */
  theme: string;
  defaults: DeckDefaults;
  assets: DeckAsset[];
  slides: Slide[];
}

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

/** A lightweight layout starter — merely pre-places elements when a slide is
 *  created; never a runtime constraint (D7: a few starters, not a library). */
export type LayoutId =
  | "title"
  | "section"
  | "content-figure"
  | "two-column"
  | "full-bleed"
  | "blank";

/** The stage camera ({x,y} in stage coords = the focus point; zoom ≥ 1 pushes
 *  in). A per-beat camera animates a transform on the stage group — the 3b1b
 *  "zoom into the interesting part" move (fully Tier-1). */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Slide {
  id: Id;
  name?: string;
  layout?: LayoutId;
  /** Slide background (CSS color); falls back to the theme background. */
  background?: string;
  /** Transition played when entering this slide. */
  transition?: TransitionKind;
  /** Speaker notes (markdown) — feeds the presenter view. */
  notes?: string;
  /** Base camera; beats can move it. */
  camera?: Camera;
  elements: SlideElement[];
  beats: Beat[];
}

// ---------------------------------------------------------------------------
// Elements — the figure model + a slide superset (§4.1)
// ---------------------------------------------------------------------------

/** A slide element is the figure `Element` union (text|rect|ellipse|line|path|
 *  image|plot — reused verbatim, so a plot is the same addressable
 *  `SemanticPlotElement`; every svg IS a plot since figure-v1 P4, and
 *  migrateDeck converts legacy `type:"svg"` on load) PLUS four slide-only
 *  types. All extend `ElementBase`, so position/size/rotation/opacity/group +
 *  the editor's drag/resize/snap are uniform across every kind. */
export type SlideElement =
  | Element
  | TextBoxElement
  | MathElement
  | VideoElement
  | EmbedFigureElement;

export type SlideElementType = SlideElement["type"];

/** One independently-revealable line/paragraph within a text box. "Reveal
 *  bullets one at a time" = a stagger over `blocks`. */
export interface TextBlock {
  id: Id;
  /** Inline text (a small markdown subset: **bold**, *italic*, `code`). */
  text: string;
  /** Indent level (0 = top). */
  level?: number;
  marker?: "none" | "bullet" | "number" | "dash";
  /** Visual emphasis keyed to the theme. */
  emphasis?: "none" | "accent" | "muted";
}

/** The workhorse for titles, body, and bullets — rendered as HTML for real
 *  typography (wrapping, markers, indent). */
export interface TextBoxElement extends ElementBase {
  type: "textBox";
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  lineHeight?: number;
  /** Auto-fit the font size down so the text fills the box without overflow. */
  autoFit?: boolean;
  blocks: TextBlock[];
}

/** A KaTeX-typeset equation. Supports the `writeOn` preset. */
export interface MathElement extends ElementBase {
  type: "math";
  tex: string;
  /** Display (block, centered) vs inline. */
  display?: boolean;
  color?: string;
  fontSize?: number;
}

/** A `<video>` element backed by a deck asset; plays/pauses on its build beat. */
export interface VideoElement extends ElementBase {
  type: "video";
  assetId: Id;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  /** A poster asset id (a still frame shown before play). */
  poster?: Id;
}

/** A whole project figure (composed via the existing `figureToSvg`) dropped as
 *  one unit whose panels stay addressable (so you can stagger a figure's panels
 *  a→b→c). Distinct from placing a single `plot`. */
export interface EmbedFigureElement extends ElementBase {
  type: "embedFigure";
  /** A figure id from the project's `fig/` subsystem. */
  figureId: string;
  /** Scope the live embed to ONE named group inside the figure (figure-v1
   *  group insertables): only that group's subtree renders, viewBox tight on
   *  its bbox. Absent = the whole figure. */
  groupId?: string;
  fit?: "contain" | "cover" | "fill";
}

// ---------------------------------------------------------------------------
// Beats — the build timeline (the spine of motion) (§4.2)
// ---------------------------------------------------------------------------

/** The preset catalog (§5.3). Each compiles a track → WAAPI keyframes (or a
 *  bespoke driver for `morph`/`countUp`). Tier-2 (paint) presets — drawOn,
 *  drawOff, morph, countUp — are used on few paths while the scene is still (P5).
 *  Three families: ENTERS (hidden before their beat), EXITS (hidden after —
 *  fadeOut/popOut/drawOff/wipeOut), and emphasis/transform (always present). */
export type PresetName =
  | "fade"
  | "fadeRise"
  | "popIn"
  | "drawOn"
  | "growBaseline"
  | "stagger"
  | "writeOn"
  | "fadeOut"
  | "popOut"
  | "drawOff"
  | "wipeOut"
  | "highlight"
  | "dim"
  | "move"
  | "scale"
  | "rotate"
  | "camera"
  | "countUp"
  | "morph";

/** Select a *set* of animation targets within an element — by role/series/index
 *  for a plot's parts, or `blocks` for a text box's lines. */
export interface TrackSelector {
  /** A plot part role: "point" | "line" | "bar" | "guide" | "overlay" | … */
  role?: string;
  /** A plot series id, e.g. "control". */
  series?: string;
  /** One or more datum indices. */
  index?: number | number[];
  /** Text-box blocks: "all" or an explicit list of block ids. */
  blocks?: "all" | Id[];
}

/** Stagger a set: each child starts `perMs` after the previous, ordered `by`
 *  and seeded `from` an edge/center. */
export interface Stagger {
  perMs: number;
  /** Ordering key for the stagger ramp. "index" = target array order; "x"/"y" =
   *  each target's spatial coordinate (data-x/data-y, falling back to the rendered
   *  x/y), so points fire left→right ("x") or low→high ("y") regardless of the
   *  order they were emitted in — the basis for the scatter "left to right" reveal. */
  by?: "index" | "x" | "y" | "blocks" | "series" | "dom";
  from?: "start" | "end" | "center" | "edges";
}

/** The destination of a `morph` (a second same-structure plot asset) or a
 *  `camera` move (a stage pose). */
export interface TrackTarget {
  /** morph: a second semantic-plot asset id (same generator/series ⇒ same ids). */
  assetId?: Id;
  /** camera: the pose to move to. */
  x?: number;
  y?: number;
  zoom?: number;
  /** move/scale/rotate: an explicit pose delta (preset-specific). */
  [prop: string]: number | string | undefined;
}

/** A single explicit keyframe — the forward-compatible full-keyframing path
 *  (§4.3). When a track carries `keyframes`, `preset` becomes optional and the
 *  renderer animates these props directly. Purely additive over the preset
 *  shape; no migration. */
export interface Keyframe {
  /** Normalized time within the track, 0..1. */
  at: number;
  /** CSS/SVG props to animate (transform, opacity, …). */
  props: Record<string, string | number>;
}

/** One animation within a beat. `start`/`duration` form the within-beat
 *  mini-timeline (ms). `target` is an element id, or `@camera`/`@stage`. */
export interface Track {
  /** Stable identity for editor selection / timeline keying / reorder. Populated
   *  at every creation point (setAnimation, autobuild) and backfilled for legacy
   *  decks at load (`ensureTrackIds`); optional only so older Track literals and
   *  on-disk decks predating it still type-check. */
  id?: Id;
  target: string;
  /** A single plot semantic id (e.g. "control.line"). */
  part?: string;
  /** A set of targets (mutually exclusive-ish with `part`). */
  selector?: TrackSelector;
  preset?: PresetName;
  params?: Record<string, unknown>;
  start?: number;
  duration?: number;
  easing?: EasingToken;
  /** After Effects-style velocity profile, 0–100% each. `out` = outgoing influence
   *  (slow-out at the start), `in` = incoming (slow-in at the end). Overrides
   *  `easing` when set: maps to cubic-bezier(out/100, 0, 1 − in/100, 1). */
  influence?: Influence;
  stagger?: Stagger;
  /** morph/camera/move destination. */
  to?: TrackTarget;
  /** Forward-compat full keyframes (preset optional when present). */
  keyframes?: Keyframe[];
  /** A disabled track is invisible to the player/static-state/export but keeps
   *  its authored timing — this is how Mask stays NON-destructive (masking a
   *  part disables its tracks instead of deleting them, so Mask→Animate
   *  round-trips lose nothing). */
  disabled?: boolean;
}

/** A beat is one "advance" step. Entering it plays its `tracks` concurrently
 *  (each at its own `start` offset). Beat 0 is the slide's resting state. */
export interface Beat {
  id: Id;
  label?: string;
  advance?: AdvanceMode;
  /** For `advance:"auto"` — ms after the previous beat finishes. */
  autoDelayMs?: number;
  tracks: Track[];
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** A resolved theme: concrete values (NOT app-only CSS vars) so the exported,
 *  offline HTML renders identically. The stage applies these as scoped CSS
 *  custom properties (`--sl-bg`, `--sl-text`, …) that elements default to. */
export interface DeckTheme {
  id: string;
  name: string;
  /** Default slide background. */
  background: string;
  /** A slightly raised surface (chrome/cards in present mode). */
  surface: string;
  /** Body text. */
  text: string;
  /** Brightest text (titles, emphasis). */
  textHi: string;
  /** Muted/secondary text. */
  textMuted: string;
  /** The single restrained accent (a 3b1b blue). */
  accent: string;
  /** A brighter accent for hovers/highlights. */
  accentBright: string;
  /** Serif content font stack (titles + body). */
  fontTitle: string;
  fontBody: string;
  /** Monospace stack (code). */
  fontMono: string;
}

// ---------------------------------------------------------------------------
// Helpers — type guards over the slide-only element types
// ---------------------------------------------------------------------------

export function isTextBox(el: SlideElement): el is TextBoxElement {
  return el.type === "textBox";
}
export function isMath(el: SlideElement): el is MathElement {
  return el.type === "math";
}
export function isVideo(el: SlideElement): el is VideoElement {
  return el.type === "video";
}
export function isEmbedFigure(el: SlideElement): el is EmbedFigureElement {
  return el.type === "embedFigure";
}

/** The deck entry as stored in `project.json.slides[]` (the `SlideEntry` type,
 *  extended leniently with title/order). */
export interface DeckEntry {
  id: string;
  path: string;
  title?: string;
  order?: number;
}
