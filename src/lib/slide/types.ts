// ---------------------------------------------------------------------------
// Flux Slide — the deck data model.
//
// A deck is a plain, diffable `slides/<deckId>/deck.json` (the source of truth)
// plus a deck-local `assets/` dir and an optional `theme.json`. A human and an
// agent author the *same* file (Flux's "the file is the API"). Keep this shape
// JSON-friendly (no class instances, functions, or DOM) so the on-disk format
// stays open and inspectable, exactly like `src/lib/types.ts`.
//
// Slides reuse the shared figure editor scene and add a slide-only video
// element. Canonical Figure files keep their original element union.
// The beat/track timeline controls appearance, transforms, and independent
// video playback commands; a visible clip rests on its poster until started.
// ---------------------------------------------------------------------------

import type { Curve, EASING_TOKENS } from "./curves";
export type { Curve } from "./curves";

import type { Element, Id, GroupDef, Asset, ColorGroup, TextStyle } from "../types";

// The 0.x minor slot is breaking. 0.6 (animation v2) adds part-set transform
// targets, the hand-off Become (`to.become`), deck animation styles and timing
// anchors, and the plot data view — an older app would play a hand-off wrong,
// so it must refuse. 0.2–0.5 migrate by a pure stamp without rewriting content.
export const DECK_SCHEMA_VERSION = "0.6.0";
export type { VideoElement } from "./mediaTypes";

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
export type EasingToken = (typeof EASING_TOKENS)[number];

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

/** A deck-level, linkable animation style (0.6) — the `TextStyle` pattern for
 *  animation: the reusable HOW of a track (preset, params, timing, easing,
 *  stagger) that many tracks reference through `Track.styleId`. Resolution is
 *  at compile time (`slide/resolve.ts`): a field present on the track wins,
 *  an absent field inherits, so editing the style restyles every linked track
 *  live. `track` uses the same shape machine-global presets carry. */
export interface AnimStyle {
  id: Id;
  name: string;
  family: "appearance" | "transform" | "media";
  track: Pick<Track, "preset" | "params" | "start" | "duration" | "easing" | "influence" | "stagger">;
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
   *  ({id,name,kind:"png"|"svg"|"mp4",path,naturalWidth,naturalHeight,dpi?}), with
   *  `path` relative to `slides/<deckId>/` (e.g. "assets/photo.png").
   *  Project-owned content (plots, figure-derived elements) is resolved BY ID
   *  against the project at load — never copied in here. Video playback copies
   *  and posters are deck-owned; the original clip remains under plots/_videos. */
  assets: Asset[];
  /** Last accepted intrinsic dimensions for linked project/raw assets. Keeps
   * physical plot scale consistent when a source changes while this deck is
   * closed. Missing legacy entries adopt the first observed dimensions. */
  externalAssetSizes?: Record<string, { width: number; height: number }>;
  /** Linkable animation styles (0.6). Presentation, not projected content:
   *  the overlay keeps it and `projectIntoDeck` copies it back verbatim. */
  animStyles?: AnimStyle[];
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
  /** Shared editor elements, including slide-only video clips. */
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
 *  driver for `transform`/`countUp`). Authoring families (see
 *  family.ts): APPEARANCES (enters hidden before their beat; exits hidden
 *  after — fadeOut/popOut/drawOff/wipeOut; emphasis) and TRANSFORMS (one
 *  `transform` preset: an element tweens into a different version of itself
 *  (Change), spawns copies that do (Ghost), or turns into another object
 *  (Become); decks still carrying the legacy `morph` preset normalize to it),
 *  MEDIA (video commands), and camera. */
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
  | "transform"
  | "videoStart"
  | "videoPause"
  | "videoStop";

/** Select a *set* of animation targets within a plot element — by
 *  role/series/index over the plot's part index. */
export interface TrackSelector {
  /** A plot part role: "point" | "line" | "bar" | "guide" | "overlay" | … */
  role?: string;
  /** A plot series id, e.g. "control". */
  series?: string;
  /** One or more datum indices. */
  index?: number | number[];
  /** Part ids (leaf, group or container — resolved to leaves) EXCLUDED from
   *  the match (0.6): "every series except control" is one selector. */
  except?: string[];
}

/** ONE way to name a thing that animates (0.6): an element, a set of a plot's
 *  parts, a role/series filter over a plot, or a figure group. `Track.target`
 *  + `part`/`parts`/`selector` remain the on-disk binding of a track's OWN
 *  target (`trackRef` derives the ref); `to.become.ref` names a Become's
 *  destination in this form. `targetKey(ref)` is the identity the family law
 *  compares — see slide/targets.ts. */
export interface TargetRef {
  /** The owning element (always present; `@camera` stays a Track.target string). */
  element: Id;
  /** Plot parts by parts-tree id (leaf, group or container; resolveTargets expands). */
  parts?: string[];
  /** A role/series/index filter over the plot's part index. */
  selector?: TrackSelector;
  /** A figure group (groups registry id): the union of its member elements. */
  group?: Id;
}

/** How the planner pairs source and destination outlines of a Become
 *  (slide/correspondence.ts). "auto" chooses from the data the manifests carry. */
/* The ids of slide/targets.ts PAIR_POLICIES (the one list; menu labels live there). */
export type PairPolicy = (typeof import("./targets").PAIR_POLICIES)[number]["id"];

/** Where a Become goes (0.6). `consume` is the original semantics (the
 *  destination element is deleted and its state becomes the source's `to.state`;
 *  recorded here for provenance only). `handoff` keeps both: the source morphs
 *  into the destination's live geometry on the stage flight layer, then hides
 *  while the destination reveals. */
export interface BecomeSpec {
  ref: TargetRef;
  mode: "consume" | "handoff";
  /** Pairing policy (default "auto"). */
  pair?: PairPolicy;
  /** Hand-off only: how the destination appears when the flight lands —
   *  `flip` (default) shows it at once; `draw` runs a drawOn of its stroked
   *  geometry from t = 1. */
  reveal?: "flip" | "draw";
}

/** Stagger a set: each child starts `perMs` after the previous, ordered `by`
 *  and seeded `from` an edge/center. */
export interface Stagger {
  perMs: number;
  /** Ordering key for the stagger ramp. "index" = target array order; "x"/"y" =
   *  each target's spatial coordinate (data-x/data-y, falling back to the
   *  rendered x/y), so points fire left→right ("x") or low→high ("y").
   *  (The never-implemented "series"/"dom" options were dropped in 0.3.0.) */
  by?: "index" | "x" | "y";
  from?: "start" | "end" | "center" | "edges";
}

/** The destination of a `transform` (a sparse element-state patch plus, for
 *  plots, the content half) or a `camera` move (a stage pose). */
export interface TrackTarget {
  /** transform, content half: the asset the element's content becomes — a
   *  second semantic-plot asset id (same generator/series ⇒ the data tweens;
   *  otherwise the plots crossfade). Written by Change (data target) and by
   *  every plot Become. */
  assetId?: Id;
  /** Explicit PROJECT-relative source paths for the content target —
   *  authored with `assetId` so resolvers never guess. */
  svgPath?: string;
  manifestPath?: string;
  /** camera: the pose to move to. */
  x?: number;
  y?: number;
  zoom?: number;
  /** Camera path: absent = geometric Zoom (pole); Fly zooms out for long pans. */
  path?: "pole" | "fly";
  /** Become (0.6): the destination and completion mode. A hand-off carries no
   *  `state` (the destination's own geometry is the end); a consume keeps
   *  `state` exactly as before and records the ref for provenance. */
  become?: BecomeSpec;
  /** transform: sparse element-property patch vs the track's pre-state (t1 =
   *  document state ⊕ every earlier transform on the same target, in beat
   *  order). Keys are top-level Element props (x, y, width, height, rotation,
   *  opacity, fill, stroke, strokeWidth, text, fontSize, d, nodes, x1..y2,
   *  cornerRadius, dash, crop, contentScale, overrides, …). Absent key =
   *  unchanged; `null` = the prop is deleted at t2; `overrides` patches merge
   *  per part-id (a part key of `null` deletes that part's override). `type`
   *  names the KIND the object becomes (a Become): the patch then carries the
   *  new kind's complete properties and applyState retypes. Applied by
   *  tween.applyState — never hand-compose. */
  state?: Record<string, unknown>;
  /** move/scale/rotate deltas ride the index signature (preset-specific). */
  [prop: string]: unknown;
}

/** A named, collapsible group of tracks within one beat (a purely
 *  presentational authoring aid — grouping never changes playback). Tracks
 *  reference their group via `Track.groupId`; collapse state is deck-persisted
 *  (agents can read the authoring layout; churn is negligible). */
export interface TrackGroup {
  id: Id;
  label: string;
  collapsed?: boolean;
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
  /** Ownership of automatic appearance regeneration, preserved by duplication. */
  generatedBy?: "auto-reveal";
  /** Stable identity for editor selection / timeline keying / reorder.
   *  Populated at every creation point and backfilled at load
   *  (`ensureTrackIds`); optional only so older Track literals type-check. */
  id?: Id;
  target: string;
  /** Birth of an independent ghost copy, on a whole-object transform only.
   * The target is an ordinary persisted element (fallback seed/identity).
   * Its visual starting state follows this source at the previous step's end;
   * its destination is the normal to.state patch. Unborn/disabled copies are
   * absent from presentation, including before a delayed birth starts. */
  ghostFrom?: Id;
  /** A single plot semantic id (e.g. "control.line"). */
  part?: string;
  /** Several plot part ids of the one target element (0.6) — written when a
   *  pick names more than one part; `part` stays the common single form.
   *  `semanticTargets` unions `part`, `parts` and `selector`. */
  parts?: string[];
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
  /** Timing spec, overriding influence/easing. Schema/validators land in M3. */
  curve?: Curve;
  stagger?: Stagger;
  /** transform/camera/move destination. */
  to?: TrackTarget;
  /** Forward-compat full keyframes (preset optional when present). */
  keyframes?: Keyframe[];
  /** A disabled track is invisible to the player/static-state/export but keeps
   *  its authored timing — this is how Mask stays NON-destructive. */
  disabled?: boolean;
  /** The beat-local TrackGroup this track belongs to (Beat.groups registry). */
  groupId?: Id;
  /** Linked deck animation style (0.6): absent fields inherit from
   *  `deck.animStyles`, present fields override (slide/resolve.ts). */
  styleId?: Id;
  /** Relative timing (0.6): this track starts at the anchor track's start or
   *  end (+ offset) instead of its literal `start`. Same beat only; cycles and
   *  missing anchors are issues and fall back to `start`. */
  anchor?: { trackId: Id; edge: "start" | "end"; offsetMs?: number };
}

/** A beat is one "advance" step. Entering it plays its `tracks` concurrently
 *  (each at its own `start` offset). Beat 0 is the slide's resting state.
 *  Tracks may reference element ids the figure editor has since deleted —
 *  dangling targets are TOLERATED (the player no-ops, the animator marks
 *  them, diagnostics warn) and never auto-pruned, so an undo of the deletion
 *  restores the animation intact. */
export interface Beat {
  id: Id;
  generatedBy?: "auto-reveal";
  autoPhase?: number;
  /** Ghost result whose post-birth phases these are; remapped on duplication. */
  autoTarget?: Id;
  label?: string;
  advance?: AdvanceMode;
  /** For `advance:"auto"` — ms after the previous beat finishes. */
  autoDelayMs?: number;
  tracks: Track[];
  /** Beat-local track groups (collapsible animator lanes; presentational). */
  groups?: TrackGroup[];
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
