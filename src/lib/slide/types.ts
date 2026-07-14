// ---------------------------------------------------------------------------
// Flux Slide — the deck data model.
//
// A deck is a plain, diffable `slides/<deckId>/deck.json` (the source of truth)
// plus a deck-local `assets/` dir and an optional `theme.json`. A human and an
// agent author the *same* file (Flux's "the file is the API"). Keep this shape
// JSON-friendly (no class instances, functions, or DOM) so the on-disk format
// stays open and inspectable, exactly like `src/lib/types.ts`.
//
// A SLIDE IS A FIGURE (slide-migration, 2026-07): `Slide.elements` is the
// figure `Element` union VERBATIM — there are no slide-only element types.
// A slide is a figure's worth of elements (+ the figure group registry and
// guides, so group/ungroup and the group-aware X-ray work identically) plus a
// presentation overlay: background, transition, notes, camera, and the
// beat/track build timeline. The Slide module edits slides with the figure
// editor operating on the same element model; this file owns only the
// presentation-side shapes.
//
// The beat/track model is the build timeline: a beat is one "advance" step; a
// track is one animation within it. The track shape is forward-compatible with
// full per-property keyframing — `keyframes[]` is purely additive.
//
// VIDEO SEAM: video returns later as a purpose-built slide-only element type
// (with a video-capable asset kind). When it lands, it extends the element
// union here (a discriminated addition next to the figure `Element` union) and
// adds a render branch in player/render.ts. Nothing ships now.
// ---------------------------------------------------------------------------

import type { Element, Id, GroupDef, Asset, ColorGroup, TextStyle } from "../types";

// 0.x → the MINOR slot is the breaking slot (repo convention). 0.2.0 is the
// slides-are-figures format; 0.1.x decks are a clean break (no migration —
// they fail validation and quarantine like any invalid file).
export const DECK_SCHEMA_VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

/** The stage frame every slide shares, in figure canvas px (96 units/inch —
 *  the SAME physical ruler as figures, so a fluxplot saved at print size lands
 *  at its true size on a slide exactly as it does on a figure). The default is
 *  640×360 (16:9): a ~6.7″ × 3.75″ frame. The player scales this fixed frame
 *  to any screen (vector — only aspect matters), and raster export multiplies
 *  it to any DPI. The coordinate number is arbitrary; the only thing it
 *  governs is how large a physically-sized import looks (width ÷ 96 = the
 *  slide's virtual width in inches). Do not raise it toward 1280/1920 — that
 *  is exactly what makes print-sized plots vanish. */
export interface StageSize {
  width: number;
  height: number;
}

/** Slide-to-slide transitions (kept deliberately small). */
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

/** How the presenter reaches a beat. `click` = a manual advance (the default
 *  "thing" you step to); `with-prev` chains onto the previous beat's click so
 *  several tracks land on one press; `auto` plays automatically `autoDelayMs`
 *  after the previous beat finishes. */
export type AdvanceMode = "click" | "with-prev" | "auto";

export interface DeckDefaults {
  transition: TransitionKind;
  buildEasing: EasingToken;
  advance: AdvanceMode;
}

export interface Deck {
  schemaVersion: string;
  id: Id;
  title: string;
  created: string;
  modified: string;
  /** Fixed stage frame; ALL slides share it (default 640×360, figure ruler). */
  stage: StageSize;
  /** Built-in theme id (e.g. "flux-dark") OR "./theme.json". */
  theme: string;
  defaults: DeckDefaults;
  /** Deck-level default slide background (falls back to the theme's). */
  background?: string;
  // Deck-level design tokens (mirror fig/index.json) so the figure editor's
  // palette / color-groups / text-styles work unchanged while editing a slide.
  palette?: string[];
  colorGroups?: ColorGroup[];
  textStyles?: TextStyle[];
  /** Deck-local imported media, using the FIGURE `Asset` shape verbatim
   *  ({id,name,kind:"png"|"svg",path,naturalWidth,naturalHeight,dpi?}), with
   *  `path` relative to `slides/<deckId>/` (e.g. "assets/photo.png").
   *  Project-owned content (plots, figure-derived elements) is resolved BY ID
   *  against the project at load — never copied in here. (A video-capable
   *  asset kind returns with the future video element — see the seam note.) */
  assets: Asset[];
  slides: Slide[];
}

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

/** A lightweight layout starter — merely pre-places elements when a slide is
 *  created; never a runtime constraint. */
export type LayoutId =
  | "title"
  | "section"
  | "content-figure"
  | "two-column"
  | "full-bleed"
  | "blank";

/** The stage camera ({x,y} in stage coords = the focus point; zoom ≥ 1 pushes
 *  in). A per-beat camera animates a transform on the stage group. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Slide {
  id: Id;
  name?: string;
  /** Layout-starter role tag (title/section/…); used by add-slide starters. */
  layout?: LayoutId;

  // ── static content: a figure ──────────────────────────────────────────────
  /** The SAME element union the figure editor edits. No slide-only types. */
  elements: Element[];
  /** Figure group semantics, verbatim (group/ungroup, X-ray, presets). */
  groups?: Record<Id, GroupDef>;
  /** Per-slide alignment guides (figure parity). */
  guides?: { x?: number[]; y?: number[] };

  // ── presentation overlay (the slide-only additions) ───────────────────────
  /** CSS color; falls back to deck.background, then the theme background. */
  background?: string;
  /** Transition played when entering this slide. */
  transition?: TransitionKind;
  /** Speaker notes (markdown) — feeds the presenter view. */
  notes?: string;
  /** Base camera; beats can move it. */
  camera?: Camera;
  /** Animation build timeline (tracks reference element ids). */
  beats: Beat[];
}

// ---------------------------------------------------------------------------
// Beats — the build timeline (the spine of motion)
// ---------------------------------------------------------------------------

/** The preset catalog. Each compiles a track → WAAPI keyframes (or a bespoke
 *  driver for `morph`/`countUp`). Three families: ENTERS (hidden before their
 *  beat), EXITS (hidden after — fadeOut/popOut/drawOff/wipeOut), and
 *  emphasis/transform (always present). */
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

/** Select a *set* of animation targets within a plot element — by
 *  role/series/index over the plot's part index. */
export interface TrackSelector {
  /** A plot part role: "point" | "line" | "bar" | "guide" | "overlay" | … */
  role?: string;
  /** A plot series id, e.g. "control". */
  series?: string;
  /** One or more datum indices. */
  index?: number | number[];
}

/** Stagger a set: each child starts `perMs` after the previous, ordered `by`
 *  and seeded `from` an edge/center. */
export interface Stagger {
  perMs: number;
  /** Ordering key for the stagger ramp. "index" = target array order; "x"/"y" =
   *  each target's spatial coordinate (data-x/data-y, falling back to the
   *  rendered x/y), so points fire left→right ("x") or low→high ("y"). */
  by?: "index" | "x" | "y" | "series" | "dom";
  from?: "start" | "end" | "center" | "edges";
}

/** The destination of a `morph` (a second same-structure plot asset) or a
 *  `camera` move (a stage pose). */
export interface TrackTarget {
  /** morph: a second semantic-plot asset id (same generator/series ⇒ same ids). */
  assetId?: Id;
  /** morph: explicit PROJECT-relative source paths for the target plot —
   *  authored by ops.setMorphTrack so resolvers stop guessing. */
  svgPath?: string;
  manifestPath?: string;
  /** camera: the pose to move to. */
  x?: number;
  y?: number;
  zoom?: number;
  /** move/scale/rotate: an explicit pose delta (preset-specific). */
  [prop: string]: number | string | undefined;
}

/** A single explicit keyframe — the forward-compatible full-keyframing path.
 *  When a track carries `keyframes`, `preset` becomes optional and the
 *  renderer animates these props directly. Purely additive. */
export interface Keyframe {
  /** Normalized time within the track, 0..1. */
  at: number;
  /** CSS/SVG props to animate (transform, opacity, …). */
  props: Record<string, string | number>;
}

/** One animation within a beat. `start`/`duration` form the within-beat
 *  mini-timeline (ms). `target` is an element id, or `@camera`/`@stage`. */
export interface Track {
  /** Stable identity for editor selection / timeline keying / reorder.
   *  Populated at every creation point and backfilled at load
   *  (`ensureTrackIds`); optional only so older Track literals type-check. */
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
  /** After Effects-style velocity profile, 0–100% each. Overrides `easing`
   *  when set: maps to cubic-bezier(out/100, 0, 1 − in/100, 1). */
  influence?: Influence;
  stagger?: Stagger;
  /** morph/camera/move destination. */
  to?: TrackTarget;
  /** Forward-compat full keyframes (preset optional when present). */
  keyframes?: Keyframe[];
  /** A disabled track is invisible to the player/static-state/export but keeps
   *  its authored timing — this is how Mask stays NON-destructive. */
  disabled?: boolean;
}

/** A beat is one "advance" step. Entering it plays its `tracks` concurrently
 *  (each at its own `start` offset). Beat 0 is the slide's resting state.
 *  Tracks may reference element ids the figure editor has since deleted —
 *  dangling targets are TOLERATED (the player no-ops, the animator marks
 *  them, diagnostics warn) and never auto-pruned, so an undo of the deletion
 *  restores the animation intact. */
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

/** The deck entry as stored in `project.json.slides[]` (the `SlideEntry` type,
 *  extended leniently with title/order). */
export interface DeckEntry {
  id: string;
  path: string;
  title?: string;
  order?: number;
}
