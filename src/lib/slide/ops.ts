// ---------------------------------------------------------------------------
// Flux Slide — the pure DECK mutation core (the agent-parity keystone).
//
// Slides are figures (slide-migration, 2026-07): STATIC element editing goes
// through the figure editor's shared core (src/lib/ops.ts) — this module owns
// only what a deck adds on top: deck/slide lifecycle, the beat/track build
// timeline, layout starters, and the plot-part tri-state that couples a
// static override with its animation tracks. Every function is a PURE
// `(deck: Deck, args) => result` mutating the plain types.ts model in place —
// no Svelte stores, no DOM — so three callers share this one core:
//   • the GUI:    slide store `commitDeckLive` composes the live Deck
//                 (projectIntoDeck), runs the op, and decomposes it back
//   • flux-core:  reads deck.json, calls the op, writes it back
// ---------------------------------------------------------------------------

import { makeVideoElement } from "./mediaTypes";
import type { Model3dElement } from "../model3d/types";
import type { Asset, Element, Figure, Id, SemanticPlotElement } from "../types";
import { newId } from "../ids";
import { gcGroups } from "../groups";
import { makePlotPanel, makeImagePanel, makeText, mergePartOverride, type Box, type TextOpts } from "../ops";
import { FLEXOKI } from "../flexoki";
import { DEFAULT_THEME_ID, resolveTheme } from "./theme";
import { cloneContentWithFreshIds, placeContentOnStage } from "./deckProject";
import { resolveTrack, resolveStart, ANIM_STYLE_FIELDS, INHERITED_STYLE_FIELDS, type ManifestFor } from "./resolve";
import { patchStagger } from "./stagger";
import { presetTrackOf } from "./animTemplates";
import { familyOf } from "./family";
import { defaultEasingFor, defaultTimingFor, isExitPreset } from "./presetCatalog";
import { EASING_TOKENS } from "./curves";
import { compileSlide, trackDuration, type CompileOptions } from "./compile";
import { targetOutlines } from "./targetGeometry";
import { diffState, transformPreState } from "./tween";
import { sourceAt, withGhostIdentity } from "./ghost";
import { stepOf, cascadeValue, clampTrackValue, type TrackCascadeSpec } from "../cascade";
import { isHandoff, trackRef, trackKey, targetKey, hasPartBinding, isWholeElementRef, sameRef, normalizeRef, refElementIds } from "./targets";
import { handoffTargetsOverlap, remapBecomeTarget } from "./handoffTargets";
import { modelBecomeResult, modelVideoHandoff } from "./model3dMorph";
import {
  DECK_SCHEMA_VERSION,
  type Deck,
  type AnimStyle,
  type Slide,
  type Beat,
  type Track,
  type TrackGroup,
  type LayoutId,
  type StageSize,
  type Camera,
  type TransitionKind,
  type Curve,
  type EasingToken,
  type Influence,
  type Stagger,
  type TargetRef,
  type BecomeSpec,
} from "./types";

// 16:9 on the FIGURE ruler (96 units/inch): a ~6.7″ × 3.75″ frame, so a
// print-sized fluxplot lands at the same fraction of a slide as of a figure.
// Alternates offered by the Deck panel: 4:3 = 480×360, 16:10 = 640×400.
export const DEFAULT_STAGE: StageSize = { width: 640, height: 360 };
export const STAGE_PRESETS: { label: string; width: number; height: number }[] = [
  { label: "16:9 · 640×360", width: 640, height: 360 },
  { label: "4:3 · 480×360", width: 480, height: 360 },
  { label: "16:10 · 640×400", width: 640, height: 400 },
];

const stamp = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export function slideById(deck: Deck, slideId: Id): Slide | null {
  return deck.slides.find((s) => s.id === slideId) ?? null;
}

export function beatById(slide: Slide, beatId: Id): Beat | null {
  return slide.beats.find((b) => b.id === beatId) ?? null;
}

/** Locate an element anywhere in the deck → its slide + element (or null). */
export function findElement(deck: Deck, elId: Id): { slide: Slide; el: Element } | null {
  for (const slide of deck.slides) {
    const el = slide.elements.find((e) => e.id === elId);
    if (el) return { slide, el };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deck lifecycle
// ---------------------------------------------------------------------------
export interface CreateDeckOpts {
  id?: Id;
  title?: string;
  stage?: StageSize;
  theme?: string;
  /** Seed with one blank title slide (default true). */
  withTitleSlide?: boolean;
}

/** Construct a new, valid, empty deck (one title slide by default). The single
 *  source for a blank deck — the GUI and agents both build through it. Seeds
 *  the same design tokens a blank figure project gets (Flexoki color groups +
 *  the default named text styles) so the figure editor's palette works on the
 *  deck from the first edit. */
export function createDeck(opts: CreateDeckOpts = {}): Deck {
  const now = stamp();
  const deck: Deck = {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: opts.id ?? newId("deck"),
    title: opts.title ?? "Untitled Deck",
    created: now,
    modified: now,
    stage: opts.stage ?? { ...DEFAULT_STAGE },
    theme: opts.theme ?? DEFAULT_THEME_ID,
    defaults: { transition: "fade", buildEasing: defaultEasingFor("transform"), advance: "click" },
    palette: [],
    colorGroups: structuredClone(FLEXOKI),
    textStyles: presentationTextStyles(opts.theme ?? DEFAULT_THEME_ID, opts.stage?.height ?? DEFAULT_STAGE.height),
    assets: [],
    slides: [],
  };
  if (opts.withTitleSlide !== false) addSlide(deck, { layout: "title", name: "Title", starters: true });
  return deck;
}

export function setDeckMeta(deck: Deck, patch: { title?: string; theme?: string; background?: string }): void {
  if (patch.title != null) deck.title = patch.title;
  if (patch.theme != null) deck.theme = patch.theme;
  if (patch.background != null) deck.background = patch.background;
}

export function setStageSize(deck: Deck, size: StageSize): void {
  deck.stage = { width: size.width, height: size.height };
}

export function setTheme(deck: Deck, theme: string): void {
  const before=resolveTheme(deck.theme),after=resolveTheme(theme);
  // Theme changes carry inherited-looking typography with them. Concrete
  // customized values remain deliberate document data and are left alone.
  const colors=new Map([[before.text,after.text],[before.textMuted,after.textMuted],[before.textHi,after.textHi]]);
  const restyle=(text:{color?:string;fontFamily?:string;fontWeight?:number})=>{
    if(text.color && colors.has(text.color))text.color=colors.get(text.color)!;
    const heading=(text.fontWeight??400)>=600;
    if(text.fontFamily===(heading?before.fontTitle:before.fontBody))text.fontFamily=heading?after.fontTitle:after.fontBody;
  };
  for(const slide of deck.slides)for(const el of slide.elements)if(el.type==="text")restyle(el);
  for(const style of deck.textStyles??[])restyle(style);
  deck.theme = theme;
}

/** Presentation defaults are deliberately separate from journal text defaults.
 *  Concrete values travel with the deck and render identically offline. */
export function presentationTextStyles(themeId: string, height = DEFAULT_STAGE.height) {
  const theme = resolveTheme(themeId);
  return [
    { id: "sl-title", name: "Title", fontFamily: theme.fontTitle, fontSize: Math.round(height * .09), fontWeight: 700, fontStyle: "normal" as const, color: theme.textHi },
    { id: "sl-body", name: "Body", fontFamily: theme.fontBody, fontSize: Math.round(height * .045), fontWeight: 400, fontStyle: "normal" as const, color: theme.text },
    { id: "sl-caption", name: "Caption", fontFamily: theme.fontBody, fontSize: Math.round(height * .035), fontWeight: 400, fontStyle: "normal" as const, color: theme.textMuted },
  ];
}

// ---------------------------------------------------------------------------
// Slide lifecycle
// ---------------------------------------------------------------------------
export interface AddSlideOpts {
  id?: Id;
  name?: string;
  layout?: LayoutId;
  background?: string;
  /** Insert at this index (default: append). */
  at?: number;
  /** Pre-place editable starter text for the layout (the GUI "Add slide"
   *  passes this; programmatic callers get an empty slide unless they opt in). */
  starters?: boolean;
}

/** Add a slide (always carries a resting beat 0). Returns the new slide. */
export function addSlide(deck: Deck, opts: AddSlideOpts = {}): Slide {
  const slide: Slide = {
    id: opts.id ?? newId("slide"),
    name: opts.name ?? `Slide ${deck.slides.length + 1}`,
    layout: opts.layout ?? "blank",
    elements: [],
    beats: [{ id: newId("beat"), label: "base", tracks: [] }],
  };
  if (opts.background != null) slide.background = opts.background;
  const at = opts.at;
  if (at != null && at >= 0 && at <= deck.slides.length) deck.slides.splice(at, 0, slide);
  else deck.slides.push(slide);
  if (opts.starters) applyLayoutStarters(deck, slide.id, slide.layout ?? "blank");
  return slide;
}

/** Pre-place editable starter FIGURE TEXT elements for a layout — sized on
 *  the figure-scale ruler (canvas px, 96/inch; pt × 4/3). Theme fonts apply at
 *  creation time (copied into the created elements); changing the deck theme
 *  later does not restyle existing text. `full-bleed`/`blank` stay empty. */
export function applyLayoutStarters(deck: Deck, slideId: Id, layout: LayoutId): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const W = deck.stage.width;
  const H = deck.stage.height;
  const box = (fx: number, fy: number, fw: number, fh: number) => ({
    x: Math.round(fx * W),
    y: Math.round(fy * H),
    width: Math.round(fw * W),
    height: Math.round(fh * H),
  });
  // Slide text sizes on the figure ruler: a 640-wide stage projects ~10× on a
  // screen, so 24 px ≈ a 44 pt projected title; body ≈ 20 pt. Stored px.
  const title = Math.round(H * 0.09);
  const body = Math.round(H * 0.045);
  const add = (b: Box, text: string, style: TextOpts) =>
    addSlideText(deck, slideId, { text, ...b, fontFamily: style.fontWeight === 700 ? resolveTheme(deck.theme).fontTitle : resolveTheme(deck.theme).fontBody,
      color: style.fontWeight === 700 ? resolveTheme(deck.theme).textHi : resolveTheme(deck.theme).text, ...style });
  if (layout === "title") {
    add(box(0.1, 0.34, 0.8, 0.18), "Title", { fontSize: title, fontWeight: 700, align: "center", sizing: "auto-h" });
    add(box(0.1, 0.58, 0.8, 0.1), "Subtitle", { fontSize: body, align: "center", sizing: "auto-h" });
  } else if (layout === "section") {
    add(box(0.1, 0.4, 0.8, 0.2), "Section", { fontSize: Math.round(H * 0.078), fontWeight: 700, align: "center", sizing: "auto-h" });
  } else if (layout === "content-figure") {
    add(box(0.06, 0.08, 0.88, 0.13), "Title", { fontSize: Math.round(H * 0.061), fontWeight: 700, sizing: "auto-h" });
    add(box(0.06, 0.28, 0.42, 0.6), "• Point one\n• Point two\n• Point three", { fontSize: body, sizing: "auto-h", lineHeight: 1.5 });
  } else if (layout === "two-column") {
    add(box(0.06, 0.08, 0.88, 0.13), "Title", { fontSize: Math.round(H * 0.061), fontWeight: 700, sizing: "auto-h" });
    add(box(0.06, 0.28, 0.42, 0.6), "• Left column", { fontSize: body, sizing: "auto-h", lineHeight: 1.5 });
    add(box(0.52, 0.28, 0.42, 0.6), "• Right column", { fontSize: body, sizing: "auto-h", lineHeight: 1.5 });
  }
  // full-bleed / blank: intentionally empty.
}

/** Delete a slide. Returns the id that should become active next (or null). */
export function deleteSlide(deck: Deck, slideId: Id): { nextActiveId: Id | null } {
  const i = deck.slides.findIndex((s) => s.id === slideId);
  if (i < 0) return { nextActiveId: deck.slides[0]?.id ?? null };
  deck.slides.splice(i, 1);
  const next = deck.slides[i] ?? deck.slides[i - 1] ?? null;
  return { nextActiveId: next?.id ?? null };
}

/** Duplicate a slide (all elements + groups + beats), remapping element/group/
 *  beat/track ids and retargeting the copy's tracks at the copy's elements —
 *  the one op that must re-map beat targets when element ids change. */
export function duplicateSlide(deck: Deck, slideId: Id): Id | null {
  const src = slideById(deck, slideId);
  if (!src) return null;
  const i = deck.slides.findIndex((s) => s.id === slideId);
  const { elements, groups, idRemap, groupRemap } = cloneContentWithFreshIds(src.elements, src.groups);
  const copy: Slide = {
    ...structuredClone(src),
    id: newId("slide"),
    name: `${src.name ?? "Slide"} copy`,
    elements,
    ...(Object.keys(groups).length ? { groups } : {}),
  };
  if (!Object.keys(groups).length) delete copy.groups;
  for (const beat of copy.beats) {
    beat.id = newId("beat");
    remapBeatGroupIds(beat);
    remapBeatTrackIds(beat);
    if (beat.autoTarget) beat.autoTarget = idRemap.get(beat.autoTarget) ?? beat.autoTarget;
    for (const t of beat.tracks) {
      // Every track carries a stable id; a duplicated slide's tracks must get
      // FRESH ids or they collide with the source slide's.
      const mapped = idRemap.get(t.target);
      if (mapped) t.target = mapped;
      if (t.ghostFrom) t.ghostFrom = idRemap.get(t.ghostFrom) ?? t.ghostFrom;
      remapBecomeTarget(t, idRemap, groupRemap);
    }
  }
  deck.slides.splice(i + 1, 0, copy);
  return copy.id;
}

// ---------------------------------------------------------------------------
// Slide presets — machine-global whole-slide snapshots (<FluxConfig>/presets/
// slides/**.json). The snapshot embeds asset BYTES (data URLs) so a preset is
// self-contained across projects; this pure op only handles the model half —
// the caller (GUI presetLib / a future verb) registers bytes for the ids in
// the returned remap.
// ---------------------------------------------------------------------------
export interface SlidePresetAssetEntry {
  /** The asset row as it existed at save time (id/path are remapped at insert). */
  asset: Asset;
  /** The bytes, as a data: URL (the renderer's native asset currency). */
  data: string;
  /** A REAL fluxplot manifest/recipe riding along (derived manifests re-derive). */
  manifest?: unknown;
  recipe?: unknown;
  /** Explicitly inactive raw 3D metadata is preserved, never activated by thumbnails. */
  modelMetadataActive?: boolean;
}
export interface SlidePresetSnapshot {
  fluxPreset: 1;
  kind: "slide";
  name: string;
  savedAt: string;
  /** Stage the slide was authored on (informational; insert never rescales). */
  stage: StageSize;
  /** The EFFECTIVE background at save time (slide → deck → theme), for the
   *  picker thumbnail only. slide.background stays sparse: a theme-following
   *  slide keeps following the TARGET deck's theme after insert. */
  thumbBackground?: string;
  /** Derived Design mesh PNGs for portable picker thumbnails, keyed by element. */
  modelPosters?: Record<string, string>;
  /** The slide verbatim (id/name ignored at insert; beats/tracks remapped). */
  slide: Slide;
  assets?: SlidePresetAssetEntry[];
  animStyles?: AnimStyle[];
}

/** Insert a preset snapshot as a NEW slide (duplicateSlide's remap discipline:
 *  fresh element/group/beat/track ids, tracks retargeted at the clones).
 *  Embedded assets whose id already exists in deck.assets are reused; the rest
 *  join deck.assets under FRESH ids (path assets/<id>.<kind>) and come back in
 *  `assetRemap` (old → new) so the caller can register their bytes. */
export function insertSlideSnapshot(
  deck: Deck,
  snap: SlidePresetSnapshot,
  opts: { at?: number } = {},
): { slideId: Id; assetRemap: Map<Id, Id> } {
  const styleRemap = new Map<Id, Id>();
  for (const style of snap.animStyles ?? []) {
    const existing = deck.animStyles?.find(s => s.name === style.name && s.family === style.family);
    styleRemap.set(style.id, existing?.id ?? addAnimStyle(deck, style).id);
  }
  const assetRemap = new Map<Id, Id>();
  const embeddedIds = new Set((snap.assets ?? []).map(entry => entry.asset.id));
  for (const entry of snap.assets ?? []) {
    const aid = entry.asset.id;
    if (deck.assets.some((a) => a.id === aid)) continue; // same source asset, already here
    const nid = newId("asset");
    assetRemap.set(aid, nid);
    const asset = { ...structuredClone(entry.asset), id: nid, path: `assets/${nid}.${entry.asset.kind}` };
    if (asset.kind === "mp4") delete asset.sourcePath;
    deck.assets.push(asset);
  }
  const { elements, groups, idRemap, groupRemap } = cloneContentWithFreshIds(snap.slide.elements, snap.slide.groups);
  for (const el of elements) {
    const withAsset = el as { assetId?: Id };
    if (el.type === "video" && assetRemap.has(el.posterAssetId)) el.posterAssetId = assetRemap.get(el.posterAssetId)!;
    if (el.type === "plot" && embeddedIds.has(el.assetId)) delete el.source;
    if (withAsset.assetId && assetRemap.has(withAsset.assetId)) {
      withAsset.assetId = assetRemap.get(withAsset.assetId)!;
      // Embedded bytes are now deck-owned. An old project's source path must
      // never overwrite the self-contained preset after insertion elsewhere.
      if (el.type === "plot") delete el.source;
    }
  }
  const slide: Slide = {
    ...structuredClone(snap.slide),
    id: newId("slide"),
    name: snap.name || (snap.slide.name ?? "Preset slide"),
    elements,
    ...(Object.keys(groups).length ? { groups } : {}),
  };
  if (!Object.keys(groups).length) delete slide.groups;
  if (!slide.beats?.length) slide.beats = [{ id: newId("beat"), label: "base", tracks: [] }];
  for (const beat of slide.beats) {
    beat.id = newId("beat");
    remapBeatGroupIds(beat);
    remapBeatTrackIds(beat);
    if (beat.autoTarget) beat.autoTarget = idRemap.get(beat.autoTarget) ?? beat.autoTarget;
    for (const t of beat.tracks) {
      if (t.styleId) t.styleId = styleRemap.get(t.styleId) ?? t.styleId;
      const mapped = idRemap.get(t.target);
      if (mapped) t.target = mapped;
      if (t.ghostFrom) t.ghostFrom = idRemap.get(t.ghostFrom) ?? t.ghostFrom;
      remapBecomeTarget(t, idRemap, groupRemap);
      if (t.to?.assetId && embeddedIds.has(t.to.assetId)) {
        t.to.assetId = assetRemap.get(t.to.assetId) ?? t.to.assetId;
        delete t.to.svgPath; delete t.to.manifestPath; delete t.to.recipePath;
        delete t.to.external; delete t.to.frozen;
      }
    }
  }
  const at = opts.at;
  if (at != null && at >= 0 && at <= deck.slides.length) deck.slides.splice(at, 0, slide);
  else deck.slides.push(slide);
  return { slideId: slide.id, assetRemap };
}

/** Reorder slides by an explicit id ordering (ids omitted keep their tail order). */
export function reorderSlides(deck: Deck, order: Id[]): void {
  const byId = new Map(deck.slides.map((s) => [s.id, s] as const));
  const seen = new Set<Id>();
  const next: Slide[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s && !seen.has(id)) {
      next.push(s);
      seen.add(id);
    }
  }
  for (const s of deck.slides) if (!seen.has(s.id)) next.push(s);
  deck.slides = next;
}

export interface SetSlidePatch {
  name?: string;
  layout?: LayoutId;
  background?: string;
  transition?: TransitionKind;
  notes?: string;
  camera?: Camera;
}

export function setSlide(deck: Deck, slideId: Id, patch: SetSlidePatch): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  if (patch.name != null) s.name = patch.name;
  if (patch.layout != null) s.layout = patch.layout;
  if (patch.background != null) s.background = patch.background;
  if (patch.transition != null) s.transition = patch.transition;
  if (patch.notes != null) s.notes = patch.notes;
  if (patch.camera != null) s.camera = patch.camera;
}

// ---------------------------------------------------------------------------
// Content adders — thin wrappers over the FIGURE constructors (the shared
// element core), for headless authoring. GUI editing never comes through
// here — it uses the figure editor's own tools/ops on the projected store.
// ---------------------------------------------------------------------------

/** Append a fully-formed figure element to a slide; returns its id (or null). */
export function addElement(deck: Deck, slideId: Id, el: Element): Id | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  s.elements.push(el);
  return el.id;
}

/** Add a figure `text` element to a slide — the SAME constructor + headless
 *  text-layout convention `add_fig_text` uses (makeText; a wrapping sizing
 *  mode gets `needsLayout` handled by the shared ops when edited). */
export function addSlideText(
  deck: Deck,
  slideId: Id,
  opts: { text: string } & Box & TextOpts,
): Id | null {
  const theme = resolveTheme(deck.theme);
  return addElement(deck, slideId, makeText(opts.text, opts, {
    fontFamily: theme.fontBody, color: theme.text, fontSize: Math.round(deck.stage.height * .045), ...opts,
  }, false));
}

/** Drop a semantic plot on a slide — the SAME SemanticPlotElement the figure
 *  editor uses (parts addressable + animation-ready). */
export function addPlotToSlide(
  deck: Deck,
  slideId: Id,
  opts: {
    assetId: Id;
    source?: SemanticPlotElement["source"];
    manifestRef?: SemanticPlotElement["manifestRef"];
  } & Box,
): Id | null {
  return addElement(deck, slideId, makePlotPanel(opts.assetId, opts, opts.source, opts.manifestRef));
}

/** Drop an image (by asset id) on a slide. */
export function addImageToSlide(deck: Deck, slideId: Id, opts: { assetId: Id } & Box): Id | null {
  return addElement(deck, slideId, makeImagePanel(opts.assetId, opts));
}

/** Place a prepared video using the same geometry as ordinary images. */
export function addVideoToSlide(deck: Deck, slideId: Id, opts: {
  assetId: Id; posterAssetId: Id; durationMs: number; x?: number; y?: number;
  width?: number; height?: number; muted?: boolean; loop?: boolean; name?: string;
}): Id | null {
  const asset = deck.assets.find(a => a.id === opts.assetId);
  if (!asset || asset.kind !== "mp4" || !deck.assets.some(a => a.id === opts.posterAssetId && a.kind === "png")) return null;
  if (!Number.isFinite(opts.durationMs) || opts.durationMs <= 0) return null;
  return addElement(deck, slideId, makeVideoElement({ ...asset, durationMs: opts.durationMs }, opts.posterAssetId, deck.stage, opts));
}

/** Media commands coexist with appearance and Change on the same step. */
export function setVideoTrack(deck: Deck, slideId: Id, beatId: Id, target: Id,
  action: "start" | "pause" | "stop", opts: { start?: number } = {}): boolean {
  if (slideById(deck, slideId)?.elements.find(e => e.id === target)?.type !== "video") return false;
  const preset = { start: "videoStart", pause: "videoPause", stop: "videoStop" } as const;
  if (!preset[action] || opts.start != null && (!Number.isFinite(opts.start) || opts.start < 0)) return false;
  return setAnimation(deck, slideId, beatId, { target, preset: preset[action], duration: 0, start: opts.start ?? 0 });
}

export function setVideoSettings(deck: Deck, slideId: Id, target: Id, opts: { muted?: boolean; loop?: boolean }): boolean {
  const el = slideById(deck, slideId)?.elements.find(e => e.id === target);
  if (el?.type !== "video") return false;
  if (opts.muted != null) el.muted = opts.muted;
  if (opts.loop != null) el.loop = opts.loop;
  return true;
}

/** The headless "Send to deck onto an existing slide" (the repurposed
 *  add_slide_figure): copy a FIGURE's elements + groups onto a slide with
 *  fresh ids, at native size (same 96/in ruler → 1:1), fit-to-frame only if
 *  the content exceeds the stage. Plot parts remain addressable for
 *  animate_part. Returns the new element ids. Explicit x/y place the content's
 *  top-left instead of centering (native size kept). */
export function addFigureContentToSlide(
  deck: Deck,
  slideId: Id,
  figure: { elements: Element[]; groups?: Record<Id, import("../types").GroupDef> },
  opts: { x?: number; y?: number } = {},
): Id[] {
  const s = slideById(deck, slideId);
  if (!s) return [];
  const { elements, groups } = cloneContentWithFreshIds(figure.elements, figure.groups);
  if (opts.x != null || opts.y != null) {
    let x0 = Infinity, y0 = Infinity;
    for (const e of elements) {
      x0 = Math.min(x0, e.x);
      y0 = Math.min(y0, e.y);
    }
    const dx = (opts.x ?? x0) - x0;
    const dy = (opts.y ?? y0) - y0;
    for (const e of elements) {
      e.x += dx;
      e.y += dy;
    }
  } else {
    placeContentOnStage(elements, deck.stage);
  }
  if (Object.keys(groups).length) s.groups = { ...(s.groups ?? {}), ...groups };
  s.elements.push(...elements);
  return elements.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Plot-part tri-state (S/A/M) — the ONE static-element concern that stays
// here, because it couples a static override with the part's animation TRACKS
// (an overlay behavior with no figure equivalent).
// ---------------------------------------------------------------------------

/** Disable/enable every track on a slide that targets one plot part. Disabling
 *  (NOT deleting) is what makes the S/A/M tri-state non-destructive. */
function setPartTracksDisabled(slide: Slide, elId: Id, part: string, disabled: boolean): void {
  for (const beat of slide.beats) {
    for (const t of beat.tracks) {
      if (t.target !== elId || t.part !== part) continue;
      if (disabled) t.disabled = true;
      else delete t.disabled;
    }
  }
}

/** The three resting states the GUI offers for a plot part (or part group):
 *   • "mask"    — hidden always (override hidden:true); its tracks are DISABLED.
 *   • "show"    — visible from beat 0 (clear hidden); tracks DISABLED (no anim).
 *   • "animate" — visible only once its build track plays (clear hidden, tracks
 *                 re-ENABLED; the caller/autobuild owns adding an enter track).
 *  The static-hide half writes the SAME id-keyed override the figure editor's
 *  setPartOverride writes (survives regeneration). */
export function setPartVisibility(deck: Deck, elId: Id, part: string, mode: "show" | "animate" | "mask"): void {
  const found = findElement(deck, elId);
  if (!found || found.el.type !== "plot") return;
  const el = found.el;
  const ov = (el.overrides = el.overrides ?? {});
  if (mode === "mask") {
    ov[part] = { ...(ov[part] ?? {}), hidden: true };
    setPartTracksDisabled(found.slide, elId, part, true);
  } else {
    if (ov[part]) {
      delete ov[part].hidden;
      if (Object.keys(ov[part]).length === 0) delete ov[part];
    }
    setPartTracksDisabled(found.slide, elId, part, mode !== "animate");
  }
}

/** Merge a style patch into one plot part's override on a slide element —
 *  the SAME element-level core the figure editor's setPartOverride uses
 *  (ops.mergePartOverride); null values delete keys. */
export function setPartStyle(
  deck: Deck,
  elId: Id,
  part: string,
  patch: Record<string, string | number | boolean | null | undefined>,
): void {
  const found = findElement(deck, elId);
  if (!found || found.el.type !== "plot") return;
  mergePartOverride(found.el, part, patch);
}

// ---------------------------------------------------------------------------
// Beats + animation tracks
// ---------------------------------------------------------------------------
export interface AddBeatOpts {
  id?: Id;
  label?: string;
  advance?: Beat["advance"];
  autoDelayMs?: number;
  /** Insert at this index (default: append). */
  at?: number;
}

export function addBeat(deck: Deck, slideId: Id, opts: AddBeatOpts = {}): Beat | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  const beat: Beat = { id: opts.id ?? newId("beat"), tracks: [] };
  if (opts.label != null) beat.label = opts.label;
  if (opts.advance != null) beat.advance = opts.advance;
  if (opts.autoDelayMs != null) beat.autoDelayMs = opts.autoDelayMs;
  // Never insert before the resting beat 0 — it IS the slide's start state.
  const at = opts.at != null ? Math.max(1, opts.at) : null;
  if (at != null && at <= s.beats.length) s.beats.splice(at, 0, beat);
  else s.beats.push(beat);
  return beat;
}

export function setBeat(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  patch: { label?: string; advance?: Beat["advance"]; autoDelayMs?: number },
): void {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return;
  if (patch.label != null) b.label = patch.label;
  if (patch.advance != null) b.advance = patch.advance;
  if (patch.autoDelayMs != null) b.autoDelayMs = patch.autoDelayMs;
}

/** Every copied beat owns new track identities and local anchor references. */
function remapBeatTrackIds(beat: Beat): void {
  const ids = new Map(beat.tracks.flatMap(t => t.id ? [[t.id, newId("track")] as const] : []));
  for (const track of beat.tracks) {
    track.id = track.id ? ids.get(track.id)! : newId("track");
    if (track.anchor) track.anchor.trackId = ids.get(track.anchor.trackId) ?? track.anchor.trackId;
  }
}

/** Remap a beat's TrackGroup ids to fresh ones (duplicated beats/slides must
 *  not share group identity with their source). Mutates the beat in place. */
function remapBeatGroupIds(beat: Beat): void {
  if (!beat.groups?.length) return;
  const remap = new Map<Id, Id>();
  for (const g of beat.groups) {
    const nid = newId("tgrp");
    remap.set(g.id, nid);
    g.id = nid;
  }
  for (const t of beat.tracks) {
    if (t.groupId) t.groupId = remap.get(t.groupId) ?? t.groupId;
  }
}

/** Deep-copy a beat (fresh beat + track + group ids), inserted right after the
 *  original. Returns the new beat, or null. Beat 0 (the resting state) can't
 *  be duplicated. */
export function duplicateBeat(deck: Deck, slideId: Id, beatId: Id): Beat | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  const i = s.beats.findIndex((b) => b.id === beatId);
  if (i <= 0) return null;
  const copy = structuredClone(s.beats[i]);
  const { idRemap, groupRemap } = cloneBirthResults(s, copy.tracks);
  copy.id = newId("beat");
  if (copy.label) copy.label += " copy";
  remapBeatTrackIds(copy);
  for (const t of copy.tracks) {
    t.target = idRemap.get(t.target) ?? t.target;
    if (t.ghostFrom) t.ghostFrom = idRemap.get(t.ghostFrom) ?? t.ghostFrom;
    remapBecomeTarget(t, idRemap, groupRemap);
  }
  remapBeatGroupIds(copy);
  if (copy.autoTarget) copy.autoTarget = idRemap.get(copy.autoTarget) ?? copy.autoTarget;
  s.beats.splice(i + 1, 0, copy);
  return copy;
}

/** Delete a beat (never removes the resting beat 0). */
export function deleteBeat(deck: Deck, slideId: Id, beatId: Id): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const i = s.beats.findIndex((b) => b.id === beatId);
  if (i <= 0) return; // keep beat 0 (the resting state)
  ensureTrackIds(deck);
  removeTracks(deck, slideId, s.beats[i].tracks.flatMap(t => t.id ? [t.id] : []));
  s.beats.splice(i, 1);
}

export function reorderBeats(deck: Deck, slideId: Id, order: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s || !s.beats.length) return;
  // Beat 0 (the resting state) is pinned: it never participates in the
  // permutation, whatever the caller passed.
  const rest = s.beats[0];
  const movable = s.beats.slice(1);
  const byId = new Map(movable.map((b) => [b.id, b] as const));
  const seen = new Set<Id>();
  const next: Beat[] = [rest];
  for (const id of order) {
    const b = byId.get(id);
    if (b && !seen.has(id)) {
      next.push(b);
      seen.add(id);
    }
  }
  for (const b of movable) if (!seen.has(b.id)) next.push(b);
  s.beats = next;
}

// ---------------------------------------------------------------------------
// Track-level ops — the timeline's direct-manipulation verbs
// ---------------------------------------------------------------------------

/** Locate a track by its stable id anywhere in the deck. */
export function findTrack(deck: Deck, trackId: Id): { slide: Slide; beat: Beat; track: Track } | null {
  for (const slide of deck.slides) {
    for (const beat of slide.beats) {
      const track = beat.tracks.find((t) => t.id === trackId);
      if (track) return { slide, beat, track };
    }
  }
  return null;
}

// Linked animation styles. Bindings, endpoints, anchors, identity and the
// family-defining `preset` stay on the track; the reusable HOW lives in the
// deck. `preset` reaches linked tracks by write (link, setAnimStyle), never by
// resolution (slide/resolve.ts header).
export interface TrackEditResult { ok: boolean; reason?: string }

/** The three on-disk representations are one authoring field. For a patch
 * carrying several, preserve the resolver's precedence (curve > influence > token).
 * Undefined means no edit; null clears the group and restores inheritance. */
export interface TimingCurvePatch {
  curve?: Curve | EasingToken | null;
  influence?: Influence | null;
  easing?: EasingToken | null;
}
function patchTimingCurve(track: Pick<Track, "curve" | "influence" | "easing">, patch: TimingCurvePatch): void {
  const { curve, influence, easing } = patch;
  if (curve === undefined && influence === undefined && easing === undefined) return;
  delete track.curve; delete track.influence; delete track.easing;
  if (curve !== undefined) {
    if (typeof curve === "string") track.easing = curve;
    else if (curve !== null) track.curve = structuredClone(curve);
  } else if (influence !== undefined) {
    if (influence !== null) track.influence = { ...influence };
  } else if (easing != null) track.easing = easing;
}

/** The pane and cascade share this op for specs, tokens, legacy influence and
 * reset. An explicit influence object can retain the disk's zero sentinel;
 * user-facing zero/reset actions pass null to restore inheritance/defaults. */
export function setTrackCurve(deck: Deck, slideId: Id, trackId: Id, curve: Curve | EasingToken | { influence: Influence } | null): TrackEditResult {
  const found = findTrack(deck, trackId);
  if (!found || found.slide.id !== slideId) return { ok: false, reason: "Track not found on this slide" };
  patchTimingCurve(found.track, curve && typeof curve === "object" && "influence" in curve ? curve : { curve });
  return { ok: true };
}

function styleValid(style: Omit<AnimStyle, "id">): void {
  if (style.family === "media" && style.track.stagger != null) throw new Error("Media animation styles cannot use stagger");
  if (!style.name.trim()) throw new Error("Animation style needs a name");
  if (familyOf(style.track) !== style.family) throw new Error("Style preset and family must agree");
}

export function addAnimStyle(deck: Deck, style: Omit<AnimStyle, "id">, id = newId("astyle")): AnimStyle {
  styleValid(style);
  if (deck.animStyles?.some(s => s.id === id)) throw new Error(`Animation style already exists: ${id}`);
  const added = { ...structuredClone(style), id };
  (deck.animStyles ??= []).push(added);
  return added;
}

export function setAnimStyle(deck: Deck, id: Id, patch: Partial<Omit<AnimStyle, "id">>): boolean {
  const style = deck.animStyles?.find(s => s.id === id);
  if (!style) return false;
  const next = { ...style, ...structuredClone(patch), track: { ...style.track, ...structuredClone(patch.track) } };
  if (patch.track) patchTimingCurve(next.track, patch.track);
  styleValid(next);
  const linked = deck.slides.flatMap(s => s.beats.flatMap(b => b.tracks.filter(t => t.styleId === id)));
  if (next.family !== style.family && linked.length)
    throw new Error("Detach linked tracks before changing a style's family");
  Object.assign(style, next);
  // The one field that propagates by write: linked tracks keep their own preset.
  if (patch.track?.preset !== undefined) for (const track of linked) track.preset = style.track.preset;
  return true;
}

function materializeStyle(track: Track, deck: Deck): void {
  const resolved = presetTrackOf(resolveTrack(track, deck));
  for (const key of ANIM_STYLE_FIELDS) delete track[key];
  Object.assign(track, resolved);
  delete track.styleId;
}

export function deleteAnimStyle(deck: Deck, id: Id, opts: { detach: true }): boolean {
  if (!opts.detach || !deck.animStyles?.some(s => s.id === id)) return false;
  for (const slide of deck.slides) for (const beat of slide.beats) for (const track of beat.tracks)
    if (track.styleId === id) materializeStyle(track, deck);
  deck.animStyles = deck.animStyles.filter(s => s.id !== id);
  if (!deck.animStyles.length) delete deck.animStyles;
  return true;
}

export function linkTrackStyle(deck: Deck, slideId: Id, trackId: Id, styleId: Id | null): TrackEditResult {
  const found = findTrack(deck, trackId);
  if (!found || found.slide.id !== slideId) return { ok: false, reason: "Track not found on this slide" };
  if (styleId === null) { materializeStyle(found.track, deck); return { ok: true }; }
  const style = deck.animStyles?.find(s => s.id === styleId);
  if (!style) return { ok: false, reason: "Animation style not found" };
  const family = familyOf(found.track);
  if (family !== style.family) return { ok: false, reason: `Family mismatch: ${family} track cannot link to ${style.family} style` };
  for (const key of INHERITED_STYLE_FIELDS) delete found.track[key];
  // The preset stays on the track; a same-family style's differing preset is written once.
  if (style.track.preset != null) found.track.preset = style.track.preset;
  found.track.styleId = styleId;
  return { ok: true };
}

export function styleFromTrack(deck: Deck, slideId: Id, trackId: Id, name: string): AnimStyle | null {
  const found = findTrack(deck, trackId);
  if (!found || found.slide.id !== slideId) return null;
  const resolved = resolveTrack(found.track, deck), family = familyOf(found.track);
  if (family === "camera") return null;
  const style = addAnimStyle(deck, { name, family, track: presetTrackOf(resolved) });
  linkTrackStyle(deck, slideId, trackId, style.id);
  return style;
}

export function animateLike(deck: Deck, slideId: Id, fromTrackId: Id, toTrackIds: Id[], beatId?: Id): { styleId?: Id; linked: Id[]; refused: { trackId: Id; reason: string }[] } {
  const source = findTrack(deck, fromTrackId);
  const refused: { trackId: Id; reason: string }[] = [], linked: Id[] = [];
  if (!source || source.slide.id !== slideId) return { linked, refused: toTrackIds.map(trackId => ({ trackId, reason: "Source track not found on this slide" })) };
  if (beatId !== undefined && source.beat.id !== beatId) return { linked, refused: toTrackIds.map(trackId => ({ trackId, reason: "Source track not found in the selected beat" })) };
  const el = source.slide.elements.find(e => e.id === source.track.target);
  const label = el?.name || (el?.type === "text" ? el.text.split("\n")[0].slice(0, 60) : el?.type) || source.track.target;
  const style = deck.animStyles?.find(s => s.id === source.track.styleId) ?? styleFromTrack(deck, slideId, fromTrackId, `Like ${label}`);
  if (!style) return { linked, refused: toTrackIds.map(trackId => ({ trackId, reason: "Camera tracks cannot share animation styles" })) };
  for (const trackId of new Set(toTrackIds)) {
    if (beatId !== undefined && !source.beat.tracks.some(t => t.id === trackId)) {
      refused.push({ trackId, reason: "Target track not found in the selected beat" }); continue;
    }
    const result = linkTrackStyle(deck, slideId, trackId, style.id);
    if (result.ok) linked.push(trackId); else refused.push({ trackId, reason: result.reason! });
  }
  return { styleId: style.id, linked, refused };
}

export function setTrackAnchor(deck: Deck, slideId: Id, trackId: Id, anchor: Track["anchor"] | null): TrackEditResult {
  const found = findTrack(deck, trackId);
  if (!found || found.slide.id !== slideId) return { ok: false, reason: "Track not found on this slide" };
  if (!anchor) { delete found.track.anchor; return { ok: true }; }
  if (anchor.trackId === trackId) return { ok: false, reason: "A track cannot anchor to itself" };
  if (!found.beat.tracks.some(t => t.id === anchor.trackId)) return { ok: false, reason: "Timing anchors must name a track in the same beat" };
  if (!Number.isFinite(anchor.offsetMs ?? 0)) return { ok: false, reason: "Anchor offset must be finite" };
  const candidate = { ...found.track, anchor };
  const result = resolveStart(candidate, found.beat, deck);
  if (result.issue) return { ok: false, reason: result.issue };
  found.track.anchor = { ...anchor };
  return { ok: true };
}

/** Arc is a HOW field; zero is an explicit straight-line style override. */
export function setTrackArc(track: Track, arc: number): void {
  if (!Number.isFinite(arc) || arc < -1 || arc > 1) throw new Error("Arc must be between -1 and 1");
  track.arc = arc;
}

/** Generic timing edits share linked-style and anchored-start semantics. */
export function setTrack(deck: Deck, slideId: Id, trackId: Id, patch: {
  styleId?: Id | null; anchor?: Track["anchor"] | null;
  start?: number; duration?: number;
  stagger?: Partial<Stagger>; arc?: number;
} & TimingCurvePatch, manifestFor: ManifestFor = () => undefined): TrackEditResult {
  const found = findTrack(deck, trackId);
  if (!found || found.slide.id !== slideId) return { ok: false, reason: "Track not found on this slide" };
  const saved = structuredClone(found.track);
  const restore = (result: TrackEditResult) => {
    for (const key of Object.keys(found.track)) delete (found.track as unknown as Record<string, unknown>)[key];
    Object.assign(found.track, saved); return result;
  };
  if (patch.styleId !== undefined) {
    const result = linkTrackStyle(deck, slideId, trackId, patch.styleId);
    if (!result.ok) return result;
  }
  if (patch.anchor !== undefined) {
    const start = resolveStart(found.track, found.beat, deck, manifestFor).start;
    const result = setTrackAnchor(deck, slideId, trackId, patch.anchor);
    if (!result.ok) return restore(result);
    if (patch.anchor === null) found.track.start = start;
  }
  for (const key of ["start", "duration"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) return restore({ ok: false, reason: `${key} must be non-negative and finite` });
    if (key === "start" && found.track.anchor) {
      const current = resolveStart(found.track, found.beat, deck, manifestFor).start;
      found.track.anchor.offsetMs = (found.track.anchor.offsetMs ?? 0) + value - current;
    } else found.track[key] = value;
  }
  try {
    if (patch.stagger !== undefined) {
      if (familyOf(found.track) === "media") throw new Error("Video commands cannot stagger");
      found.track.stagger = patchStagger(resolveTrack(found.track, deck).stagger, patch.stagger);
    }
    if (patch.arc !== undefined) setTrackArc(found.track, patch.arc);
  } catch (error) { return restore({ ok: false, reason: (error as Error).message }); }
  patchTimingCurve(found.track, patch);
  return { ok: true };
}

/** Move a track into another beat on the same slide (drag a chip across
 *  columns). `at` places it at a lane index (default: append). Timing (start/
 *  duration/stagger) travels untouched; a beat-local group membership is
 *  dropped on a CROSS-beat move (groups live per beat). An anchor detaches
 *  to its resolved start before leaving the source beat, as do any followers
 *  anchored to the moved track that remain in the source beat. */
export function moveTrackToBeat(deck: Deck, slideId: Id, trackId: Id, toBeatId: Id, at?: number, manifestFor: ManifestFor = () => undefined): boolean {
  const s = slideById(deck, slideId);
  if (!s) return false;
  const to = beatById(s, toBeatId);
  if (!to) return false;
  for (const b of s.beats) {
    const i = b.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
    const candidate = b.tracks[i];
    if (to === s.beats[0]) return false;
    if (["transform", "media"].includes(familyOf(candidate)) && to.tracks.some(t => t !== candidate && tracksMatch(t, candidate))) return false;
    if (b !== to) {
      // Resolve every affected anchor against the intact source beat before
      // changing any of them. Followers left behind must keep their arrival.
      const detach = b.tracks.filter(t => t.anchor && (t === candidate || t.anchor.trackId === trackId))
        .map(track => ({ track, start: resolveStart(track, b, deck, manifestFor).start }));
      for (const { track, start } of detach) { track.start = start; delete track.anchor; }
    }
    const [t] = b.tracks.splice(i, 1);
    if (b.id !== to.id && t.groupId) delete t.groupId;
    // Splicing out of the SAME beat shifts indices; recompute a safe insert point.
    const j = at != null ? Math.max(0, Math.min(at, to.tracks.length)) : to.tracks.length;
    to.tracks.splice(j, 0, t);
    gcTrackGroups(b);
    return true;
  }
  return false;
}

/** Deep-copy a track, in place by default or directly into another beat. The
 * destination is checked before mutation: a cross-step Change copy must not
 * temporarily create the forbidden second Change in its source step. */
export function duplicateTrack(deck: Deck, slideId: Id, trackId: Id, toBeatId?: Id, at?: number, manifestFor: ManifestFor = () => undefined): Id | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  for (const b of s.beats) {
    const i = b.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
    const to = toBeatId ? beatById(s, toBeatId) : b;
    if (!to || to === s.beats[0] || b === s.beats[0]) return null;
    if (!b.tracks[i].ghostFrom && ["transform", "media"].includes(familyOf(b.tracks[i])) && to.tracks.some(t => tracksMatch(t, b.tracks[i]))) return null;
    const copy = structuredClone(b.tracks[i]);
    copy.id = newId("track");
    if (to !== b && copy.anchor) {
      copy.start = resolveStart(b.tracks[i], b, deck, manifestFor).start;
      delete copy.anchor;
    }
    if (copy.ghostFrom) {
      const { idRemap, groupRemap } = cloneBirthResults(s, [copy]);
      copy.target = idRemap.get(copy.target) ?? copy.target;
      remapBecomeTarget(copy, idRemap, groupRemap);
    }
    if (to !== b) delete copy.groupId;
    to.tracks.splice(at == null ? to === b ? i + 1 : to.tracks.length : Math.max(0, Math.min(at, to.tracks.length)), 0, copy);
    return copy.id;
  }
  return null;
}

/** A birth owns its result object. Duplicating the birth creates another
 * independent result, whereas copying an ordinary element copies no birth. */
function cloneBirthResults(slide: Slide, tracks: readonly Track[]): Pick<ReturnType<typeof cloneContentWithFreshIds>, "idRemap" | "groupRemap"> {
  const ids = new Set(tracks.filter(t => t.ghostFrom).map(t => t.target));
  const { elements, groups, idRemap, groupRemap } = cloneContentWithFreshIds(slide.elements.filter(e => ids.has(e.id)), slide.groups);
  const sources = new Map(tracks.filter(t => t.ghostFrom).map(t => [idRemap.get(t.target), t.ghostFrom!]));
  const names = new Map<Id, Set<string>>();
  for (const el of elements) {
    const source = sources.get(el.id)!;
    const used = names.get(source) ?? ghostNames(slide, source); names.set(source, used);
    el.name = nextGhostName(used); used.add(el.name);
  }
  slide.elements.push(...elements);
  if (Object.keys(groups).length) slide.groups = { ...slide.groups, ...groups };
  return { idRemap, groupRemap };
}

function ghostNames(slide: Slide, sourceId: Id): Set<string> {
  const targets = new Set(slide.beats.flatMap(b => b.tracks.filter(t => t.ghostFrom === sourceId).map(t => t.target)));
  return new Set(slide.elements.filter(e => targets.has(e.id)).flatMap(e => e.name ? [e.name] : []));
}
function nextGhostName(used: ReadonlySet<string>): string {
  let number = 1;
  while (used.has(`Ghost ${number}`)) number++;
  return `Ghost ${number}`;
}

/** Remove selected effects and, for each removed ghost birth, its owned
 * result plus every effect targeting that result. Other copies that used it
 * as a source keep their saved fallback and report the missing source. */
export function removeTracks(deck: Deck, slideId: Id, trackIds: Id[]): void {
  const slide = slideById(deck, slideId);
  if (!slide) return;
  const selected = new Set(trackIds);
  const results = new Set(slide.beats.flatMap(b => b.tracks.filter(t => t.id && selected.has(t.id) && t.ghostFrom).map(t => t.target)));
  for (const beat of slide.beats) {
    beat.tracks = beat.tracks.filter(t => !(t.id && selected.has(t.id)) && !results.has(t.target));
    gcTrackGroups(beat);
  }
  if (results.size) {
    slide.elements = slide.elements.filter(e => !results.has(e.id));
    // The shared group core reads only elements/groups from this projection.
    gcGroups(slide as unknown as Figure);
  }
}

export interface GhostTransformOptions extends TimingCurvePatch {
  count?: number;
  original?: "stay" | "disappear" | "transform";
  duration?: number;
  start?: number;
  /** Independent sparse destinations, in copy order. */
  states?: Record<string, unknown>[];
  originalState?: Record<string, unknown>;
  /** GUI may supply the compiler's manifest-aware prior-step snapshot. */
  sourceSnapshot?: Element;
}
export interface GhostTransformResult {
  elementIds: Id[];
  trackIds: Id[];
  groupId: Id;
  originalTrackId?: Id;
}

/** Make persistent ordinary objects with one explicit birth per result.
 * Geometry/content is captured only as a missing-source fallback; playback
 * derives each starting state from the source immediately before this step. */
export function addGhostTransform(deck: Deck, slideId: Id, beatId: Id, sourceId: Id, opts: GhostTransformOptions = {}): GhostTransformResult | null {
  const count = opts.count ?? 3, original = opts.original ?? "stay";
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error("Copies must be a whole number from 1 to 32");
  if (!["stay", "disappear", "transform"].includes(original)) throw new Error("Original must stay, disappear, or transform");
  if (opts.duration != null && (!Number.isFinite(opts.duration) || opts.duration < 0)) throw new Error("Duration must be a finite non-negative number");
  if (opts.start != null && (!Number.isFinite(opts.start) || opts.start < 0)) throw new Error("Start must be a finite non-negative number");
  const slide = slideById(deck, slideId), bi = slide?.beats.findIndex(b => b.id === beatId) ?? -1;
  const source = slide?.elements.find(e => e.id === sourceId);
  if (!slide || !source || bi < 1) return null;
  if (source.type === "video") throw new Error("Duplicate the video clip to create an independent copy; Ghost transforms do not support video.");
  const beat = slide.beats[bi];
  const whole = beat.tracks.filter(t => t.target === sourceId && !hasPartBinding(t) && !t.disabled);
  const changes = whole.filter(t => familyOf(t) === "transform");
  const exits = whole.filter(t => isExitPreset(t.preset));
  if (changes.length > 1 || exits.length > 1 || original === "stay" && (changes.length || exits.length) || original === "transform" && exits.length || original === "disappear" && changes.length)
    throw new Error(`The original already has a Change or exit in this step. Choose its existing behavior or edit those effects first.`);
  if (opts.sourceSnapshot && (opts.sourceSnapshot.id !== sourceId || opts.sourceSnapshot.type !== source.type)) throw new Error("Copy snapshot must belong to the selected source object");
  const available = compileSlide(slide, deck.stage, deck).copySourceState(sourceId, bi);
  if (!available) throw new Error("This source is not available before the selected step. Choose a later step or another source.");
  const snapshot = opts.sourceSnapshot ?? available;
  const groupId = newId("tgrp"), label = source.name?.trim() || source.type;
  const out: GhostTransformResult = { elementIds: [], trackIds: [], groupId };
  const names = ghostNames(slide, sourceId);
  for (let i = 0; i < count; i++) {
    const copy = structuredClone(snapshot);
    copy.id = newId(copy.type); copy.name = nextGhostName(names); names.add(copy.name);
    delete copy.groupId; delete copy.locked;
    delete (copy as unknown as Record<string, unknown>).panelLabel;
    slide.elements.push(copy);
    const track: Track = { id: newId("track"), target: copy.id, ghostFrom: sourceId, preset: "transform", groupId,
      duration: opts.duration ?? defaultTimingFor("transform").duration, easing: opts.easing ?? defaultTimingFor("transform").easing, start: opts.start ?? 0,
      to: { state: structuredClone(opts.states?.[i] ?? {}) } };
    patchTimingCurve(track, opts);
    beat.tracks.push(track); out.elementIds.push(copy.id); out.trackIds.push(track.id!);
  }
  beat.groups = [...(beat.groups ?? []), { id: groupId, label: `Ghosts of ${label}` }];
  if (original === "transform") {
    const previous = changes[0];
    const track = setTransform(deck, slideId, beatId, sourceId, {
      ...(opts.originalState ? { state: opts.originalState } : {}),
      ...(!previous ? { duration: opts.duration ?? defaultTimingFor("transform").duration, easing: opts.easing ?? defaultTimingFor("transform").easing, start: opts.start ?? 0,
        ...(opts.curve !== undefined ? { curve: opts.curve } : {}),
        ...(opts.influence !== undefined ? { influence: opts.influence } : {}),
      } : {}),
    })!;
    delete track.disabled;
    if (!previous) track.groupId = groupId;
    out.originalTrackId = track.id;
  } else if (original === "disappear") {
    // Ghost disappearance matches the births: smooth is authored, not a default (ledger 2026-09-28).
    const track = exits[0] ?? { id: newId("track"), target: sourceId, preset: "fadeOut" as const,
      duration: opts.duration ?? defaultTimingFor("transform").duration, easing: opts.easing ?? "smooth", start: opts.start ?? 0, groupId };
    if (!exits.length) { patchTimingCurve(track, opts); beat.tracks.push(track); }
    out.originalTrackId = track.id;
  }
  return out;
}

/** Set one beat's track order to `order` (a permutation of its track ids —
 *  unlisted tracks keep their relative order at the tail). Within-beat order is
 *  presentational (tracks play concurrently) but drives the timeline lanes. */
export function reorderTracks(deck: Deck, slideId: Id, beatId: Id, order: Id[]): void {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return;
  const byId = new Map(b.tracks.map((t) => [t.id, t] as const));
  const seen = new Set<Id>();
  const next: Track[] = [];
  for (const id of order) {
    const t = byId.get(id);
    if (t && t.id && !seen.has(t.id)) {
      next.push(t);
      seen.add(t.id);
    }
  }
  for (const t of b.tracks) if (!t.id || !seen.has(t.id)) next.push(t);
  b.tracks = next;
}

/** Enable/disable one track (disabled = invisible to the player, timing kept). */
export function setTrackEnabled(deck: Deck, slideId: Id, trackId: Id, enabled: boolean): boolean {
  const s = slideById(deck, slideId);
  if (!s) return false;
  for (const b of s.beats) {
    const t = b.tracks.find((x) => x.id === trackId);
    if (!t) continue;
    if (enabled) delete t.disabled;
    else t.disabled = true;
    return true;
  }
  return false;
}

/** Two tracks "match" (and thus replace, rather than stack) when they animate
 *  in the same FAMILY (family.ts) on the same TARGET — the full target
 *  identity (`targets.trackKey`: element + sorted part ids + selector), so an
 *  appearance and a transform coexist on one object in one beat, a whole-plot
 *  Change and a one-box Become coexist too, and two transforms of the SAME
 *  target (whole element, or the same part-set) replace each other: "max one
 *  transform per target per beat" — chaining happens across beats. Media
 *  commands stay whole-clip and unique per clip. */
function tracksMatch(a: Track, b: Track): boolean {
  if (a.target !== b.target) return false;
  const fam = familyOf(a);
  if (fam !== familyOf(b)) return false;
  if (fam === "media") return true;
  return trackKey(a) === trackKey(b);
}
export { tracksMatch as sameTargetAndFamily };

/** Add or replace an animation track on a beat (the keystone animation op). */
export function setAnimation(deck: Deck, slideId: Id, beatId: Id, track: Track): boolean {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b || s!.beats[0] === b) return false;
  if (familyOf(track) === "media" && (s!.beats[0] === b || s!.elements.find(e => e.id === track.target)?.type !== "video" || hasPartBinding(track) || track.stagger || track.keyframes)) return false;
  const i = b.tracks.findIndex((t) => tracksMatch(t, track));
  // Every track carries a stable id; replacing a matched track keeps its id so
  // editor selection survives the edit, a brand-new track gets a fresh one.
  // A matched track's group membership survives the replace (grouping is
  // presentational; a re-preset shouldn't eject the lane from its group).
  if (i >= 0) {
    const prev = b.tracks[i];
    b.tracks[i] = {
      ...track,
      id: track.id ?? prev.id ?? newId("track"),
      ...(track.groupId == null && prev.groupId != null ? { groupId: prev.groupId } : {}),
      ...(prev.ghostFrom ? { ghostFrom: prev.ghostFrom, preset: "transform" as const,
        ...(!track.to && prev.to ? { to: structuredClone(prev.to) } : {}) } : {}),
    };
  } else b.tracks.push({ ...track, id: track.id ?? newId("track") });
  return true;
}

/** User-facing Add is insertion, never a hidden replacement of another effect.
 *  setAnimation remains the explicit upsert used by recipes and existing verbs. */
export function appendAnimation(deck: Deck, slideId: Id, beatId: Id, track: Track): Track | null {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b || s!.beats[0] === b || (["transform", "media"].includes(familyOf(track)) && b.tracks.some(t => tracksMatch(t, track)))) return null;
  if (familyOf(track) === "media" && (s!.beats[0] === b || s!.elements.find(e => e.id === track.target)?.type !== "video" || hasPartBinding(track) || track.stagger || track.keyframes)) return null;
  const added = { ...structuredClone(track), id: newId("track") };
  b.tracks.push(added);
  return added;
}

/** Add (or update) the ONE transform track for a target on a beat — the
 *  ergonomic form agents and the GUI use so nobody hand-builds `to.state`
 *  diffs. The target is `targetId` (the whole element) or, with `opts.ref`, a
 *  part-set of that element (`parts`/`selector`); the track found or created is
 *  the one whose `targetKey` matches. Merges `state` keys over the existing
 *  patch (a key of undefined is skipped; an explicit null persists as "delete
 *  this prop at t2"); `replaceState` swaps the whole patch. Timing/easing patch
 *  only when given. Returns the track (created or updated), or null. */
export function setTransform(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  targetId: Id,
  opts: {
    /** Part-set binding of the target (0.6); absent = the whole element. */
    ref?: { parts?: string[]; selector?: Track["selector"] };
    state?: Record<string, unknown>;
    replaceState?: boolean;
    start?: number;
    duration?: number;
    arc?: number;
    /** content half: the asset the element's content becomes (+ explicit
     *  source paths; `source` carries the full bundle of a placed plot). */
    toAssetId?: Id;
    svgPath?: string;
    glbPath?: string;
    manifestPath?: string;
    source?: SemanticPlotElement["source"] | Model3dElement["source"] | null;
  } & TimingCurvePatch = {},
): Track | null {
  if (opts.arc !== undefined && (!Number.isFinite(opts.arc) || opts.arc < -1 || opts.arc > 1)) throw new Error("Arc must be between -1 and 1");
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return null;
  const want = targetKey({ element: targetId, ...(opts.ref?.parts?.length ? { parts: opts.ref.parts } : {}), ...(opts.ref?.selector ? { selector: opts.ref.selector } : {}) });
  let t = b.tracks.find((x) => familyOf(x) === "transform" && trackKey(x) === want);
  if (!t) {
    t = { id: newId("track"), target: targetId, preset: "transform", ...defaultTimingFor("transform"), to: { state: {} } };
    if (opts.ref?.parts?.length) {
      if (opts.ref.parts.length === 1) t.part = opts.ref.parts[0];
      else t.parts = [...opts.ref.parts];
    }
    if (opts.ref?.selector) t.selector = structuredClone(opts.ref.selector);
    b.tracks.push(t);
  }
  t.to = t.to ?? {};
  if (opts.replaceState) t.to.state = structuredClone(opts.state ?? {});
  else if (opts.state) {
    const cur = { ...(t.to.state ?? {}) };
    for (const [k, v] of Object.entries(opts.state)) {
      if (v === undefined) delete cur[k];
      else cur[k] = structuredClone(v);
    }
    t.to.state = cur;
  }
  if (opts.toAssetId != null) { t.to.assetId = opts.toAssetId; delete t.to.become; }
  if (opts.source !== undefined) {
    // a placed plot's whole source bundle travels with the content target
    for (const key of ["svgPath", "glbPath", "sha256", "manifestPath", "recipePath", "frozen", "external"]) delete t.to[key];
    if (opts.source) {
      if ("glbPath" in opts.source) { t.to.glbPath = opts.source.glbPath; if (opts.source.sha256) t.to.sha256 = opts.source.sha256; }
      else t.to.svgPath = opts.source.svgPath;
      if (opts.source.manifestPath != null) t.to.manifestPath = opts.source.manifestPath;
      if (opts.source.recipePath != null) t.to.recipePath = opts.source.recipePath;
      if (opts.source.frozen != null) t.to.frozen = opts.source.frozen;
      if (opts.source.external != null) t.to.external = opts.source.external;
    }
  }
  if (opts.svgPath != null) t.to.svgPath = opts.svgPath;
  if (opts.glbPath != null) t.to.glbPath = opts.glbPath;
  if (opts.manifestPath != null) t.to.manifestPath = opts.manifestPath;
  if (opts.start != null) t.start = opts.start;
  if (opts.duration != null) t.duration = opts.duration;
  patchTimingCurve(t, opts);
  if (opts.arc !== undefined) setTrackArc(t, opts.arc);
  return t;
}

/** Turntable is an ordinary linear transform; all authoring surfaces and agents
 * share this operation, including replacement and previous-beat endpoint rules. */
export function addTurntable(deck: Deck, opts: { slideId: Id; beatId: Id; target: Id; turns?: number; direction?: "cw" | "ccw"; durationMs?: number; start?: number }): Track | null {
  const turns = opts.turns ?? 1, duration = opts.durationMs ?? 6000;
  if (!Number.isFinite(turns) || turns <= 0 || !Number.isFinite(duration) || duration <= 0 || (opts.start !== undefined && (!Number.isFinite(opts.start) || opts.start < 0))) throw new Error("Turntable needs positive turns and duration, and a nonnegative start");
  if (opts.direction !== undefined && opts.direction !== "cw" && opts.direction !== "ccw") throw new Error("Turntable direction must be cw or ccw");
  const slide = slideById(deck, opts.slideId), bi = slide?.beats.findIndex(beat => beat.id === opts.beatId) ?? -1;
  if (!slide || bi <= 0) return null;
  const pre = transformPreState(slide, opts.target, bi);
  if (pre?.type !== "model3d") return null;
  return setTransform(deck, opts.slideId, opts.beatId, opts.target, { state: { orbitAzimuth: pre.orbitAzimuth + (opts.direction === "ccw" ? 1 : -1) * 360 * turns }, duration, start: opts.start ?? 0, curve: "linear" });
}
export const turntable = addTurntable;

/** Drop the content half of a transform (the object keeps its own content). */
export function clearTransformContent(track: Track): void {
  if (!track.to) return;
  for (const key of ["assetId", "svgPath", "glbPath", "sha256", "manifestPath", "recipePath", "frozen", "external", "become"]) delete track.to[key];
}

export interface BecomeOptions extends TimingCurvePatch {
  /** Metadata for saved Figure-by-id models outside the deck-local asset list. */
  modelAsset?: CompileOptions['modelAsset'];
  mode?: BecomeSpec["mode"];
  pair?: BecomeSpec["pair"];
  reveal?: BecomeSpec["reveal"];
  start?: number;
  duration?: number;
  /** GUI may supply the compiler's manifest-aware evaluation of the slide. */
  compiled?: ReturnType<typeof compileSlide>;
}
export interface BecomeResult {
  trackId: Id;
  /** Model pairs report vertex morph compatibility; false is a valid crossfade. */
  morph?: boolean;
  reason?: string;
  /** The consumed target's id (it is no longer on the slide). */
  targetId?: Id;
  /** The endpoint patch written to the track. */
  state?: Record<string, unknown>;
  /** The live destination of a hand-off (neither object is consumed). */
  ref?: TargetRef;
}

/** Become consumes a loose drawn destination or hands off to live targets.
 * Both completions write THE source transform in one mutation. Refusals run
 * before any write and carry a user-facing reason. */
export function becomeTransform(deck: Deck, slideId: Id, beatId: Id, source: Id, dest: Id, opts?: BecomeOptions): BecomeResult | null;
export function becomeTransform(deck: Deck, slideId: Id, beatId: Id, source: TargetRef | Id, dest: TargetRef | Id, opts?: BecomeOptions): BecomeResult | null;
export function becomeTransform(deck: Deck, slideId: Id, beatId: Id, sourceRef: TargetRef | Id, dest: TargetRef | Id, opts: BecomeOptions = {}): BecomeResult | null {
  sourceRef = typeof sourceRef === "string" ? { element: sourceRef } : sourceRef;
  if (sourceRef.members) throw new Error("Choose an object or plot parts as the Become source, rather than a set of objects.");
  // A destination set is canonicalized once (dedupe, merge, 1-member collapse).
  const ref = normalizeRef(typeof dest === "string" ? { element: dest } : dest);
  const slide = slideById(deck, slideId), bi = slide?.beats.findIndex((b) => b.id === beatId) ?? -1;
  if (!slide || bi < 0) return null;
  // Every route (canvas clicks in any order, X-ray, Appear from…, CLI) writes
  // the same bytes: set members are stored in the slide's own object order.
  if (ref.members) {
    const order = new Map(slide.elements.map((e, i) => [e.id, i] as const));
    ref.members = ref.members.map((m, i) => [m, i] as const).sort((a, b) => (order.get(a[0].element) ?? Infinity) - (order.get(b[0].element) ?? Infinity) || a[1] - b[1]).map(([m]) => m);
    ref.element = ref.members[0].element;
  }
  const sourceId = sourceRef.element, targetId = ref.element;
  if (bi < 1) throw new Error("Become needs a build step after Design. Choose or add a step first.");
  if (sameRef(sourceRef, ref)) throw new Error("Choose a different object for the source to become.");
  if (sourceRef.group) throw new Error("Choose an object or plot parts as the Become source, rather than a group.");
  const source = slide.elements.find((e) => e.id === sourceId), target = slide.elements.find((e) => e.id === targetId);
  if (!source) throw new Error("The source object is missing from this slide.");
  if (!target) throw new Error("The object to become is missing from this slide.");
  if (refElementIds(ref).some(id => !slide.elements.some(e => e.id === id))) throw new Error("One of the destination objects is missing from this slide.");
  // The whole source hides at landing, and every part inside it with it.
  if (target.type === "model3d" && sourceId === targetId && isWholeElementRef(sourceRef) && !ref.group)
    throw new Error("A 3D model cannot become one of its own parts. Fade the part in with Appear instead.");
  const posterVideo = isWholeElementRef(sourceRef) && isWholeElementRef(ref) && modelVideoHandoff(source, target);
  if ((source.type === "video" || target.type === "video") && (!posterVideo || opts.mode === "consume")) throw new Error("Video clips cannot take part in a Become. Use Change for their geometry.");
  if (opts.duration != null && (!Number.isFinite(opts.duration) || opts.duration < 0)) throw new Error("Duration must be a finite non-negative number");
  if (opts.start != null && (!Number.isFinite(opts.start) || opts.start < 0)) throw new Error("Start must be a finite non-negative number");
  const compiled = opts.compiled ?? compileSlide(slide, deck.stage, { ...deck, modelAsset: opts.modelAsset });
  const mode = opts.mode ?? (!posterVideo && isWholeElementRef(sourceRef) && isWholeElementRef(ref) && target.type !== "plot" && target.type !== "image" && target.type !== "model3d" && (!target.groupId || !slide.groups?.[target.groupId]) ? "consume" : "handoff");
  const existing = slide.beats[bi].tracks.find(t => familyOf(t) === "transform" && trackKey(t) === targetKey(sourceRef));
  const timing = {
    ...(!existing ? { duration: opts.duration ?? defaultTimingFor("transform").duration, easing: opts.easing ?? defaultTimingFor("transform").easing, start: opts.start ?? 0 } : {}),
    ...(opts.duration != null ? { duration: opts.duration } : {}),
    ...(opts.easing !== undefined ? { easing: opts.easing } : {}),
    ...(opts.curve !== undefined ? { curve: opts.curve } : {}),
    ...(opts.influence !== undefined ? { influence: opts.influence } : {}),
    ...(opts.start != null ? { start: opts.start } : {}),
  };
  if (mode === "handoff") {
    const destination = compiled.resolveTarget(ref, bi), sources = compiled.resolveTarget(sourceRef, bi);
    if (!destination.length) throw new Error("Destination parts not found. Retarget this Become.");
    if (!sources.length) throw new Error("Source parts not found. Retarget this Become.");
    // A set's members must stay clear of the source: it hides as they land.
    if (ref.members && handoffTargetsOverlap(sources, destination)) throw new Error("The destination set includes the source. Pick other objects for it to become.");
    const ids = new Set([...sources, ...destination].map(t => t.elementId));
    if (!posterVideo && slide.elements.some(e => ids.has(e.id) && e.type === "video")) throw new Error("Video clips cannot take part in a Become. Use Change for their geometry.");
    // Preserve the source's effective style/anchor timing when replacing its
    // endpoint. resolvedSlide retains disabled tracks, which Become re-enables.
    const resolvedExisting = existing && compiled.resolvedSlide.beats[bi]?.tracks.find(t => t.id === existing.id);
    const start = opts.start ?? resolvedExisting?.start ?? existing?.start ?? 0;
    const unborn = compiled.births.filter(b => !b.enabled || b.beat > bi || b.beat === bi && b.start > start);
    if (unborn.some(b => destination.some(t => t.elementId === b.target))) throw new Error("The destination is not yet born at this step. Choose a later step.");
    if (unborn.some(b => sources.some(t => t.elementId === b.target))) throw new Error("The source is not yet born at this step. Choose a later step.");
    for (const other of slide.beats[bi].tracks) {
      if (other === existing || other.disabled || other.preset !== "transform" || !isHandoff(other)) continue;
      if (handoffTargetsOverlap(destination, compiled.resolveTarget(other.to.become.ref, bi)))
        throw new Error("Another hand-off in this step already lands on these destination parts. Choose different parts or another step.");
    }
    const track = setTransform(deck, slideId, beatId, sourceId, { ref: sourceRef, state: {}, replaceState: true, ...timing })!;
    track.to = { become: { ref: structuredClone(ref), mode: "handoff", pair: opts.pair ?? "auto", reveal: opts.reveal ?? "flip" }, state: {} };
    delete track.disabled;
    return { trackId: track.id!, ref: structuredClone(ref), ...modelBecomeResult(compiled.preState(sourceId, bi) ?? source, compiled.preState(targetId, bi) ?? target, { ...deck, modelAsset: opts.modelAsset }) };
  }
  if (!isWholeElementRef(sourceRef) || !isWholeElementRef(ref)) throw new Error(ref.members ? "Consume needs one whole destination object; a set of objects hands off. Use hand-off instead." : "Consume requires whole objects, without parts or groups. Use hand-off instead.");
  if (compiled.births.some((b) => b.target === targetId)) throw new Error("A ghost copy cannot be a Become target. Duplicate it into an ordinary object first.");
  const frame = compiled.sample(bi);
  if (frame.presentation.unbornElementIds?.includes(sourceId)) throw new Error("The source is not yet born at this step. Choose a later step.");
  const pre = compiled.preState(sourceId, bi);
  if (!pre) throw new Error("The source has no state before this step.");
  // the target as it stands at the END of this step, wearing the source's identity
  const evaluated = frame.elements.find((e) => e.id === targetId) ?? target;
  const endEl = withGhostIdentity(sourceAt(compiled.resolvedSlide, targetId, bi + 1, evaluated), source);
  const state = diffState(pre, endEl) ?? {};
  const track = setTransform(deck, slideId, beatId, sourceId, {
    state, replaceState: true, ...timing,
  })!;
  delete track.disabled;
  if (endEl.type === "plot" || endEl.type === "image" || endEl.type === "model3d") {
    track.to = track.to ?? {};
    track.to.assetId = endEl.assetId;
    setTransform(deck, slideId, beatId, sourceId, { source: endEl.type === "plot" || endEl.type === "model3d" ? endEl.source ?? null : null });
  } else clearTransformContent(track);
  track.to!.become = { ref: structuredClone(ref), mode: "consume" };
  // consume the target: its element, every effect on it, and its group slots
  // (ghost copies born FROM the target keep their saved fallback and report
  // the missing source, exactly as when a source is deleted by hand)
  for (const beat of slide.beats) {
    beat.tracks = beat.tracks.filter((t) => t.target !== targetId);
    gcTrackGroups(beat);
  }
  slide.elements = slide.elements.filter((e) => e.id !== targetId);
  gcGroups(slide as unknown as Figure);
  return { trackId: track.id!, targetId, state, ...modelBecomeResult(pre, endEl, { ...deck, modelAsset: opts.modelAsset }) };
}

/** Destination-side authoring of exactly the same source-owned hand-off. */
export function appearFrom(deck: Deck, slideId: Id, beatId: Id, dest: TargetRef, source: TargetRef | Id, opts: BecomeOptions = {}): BecomeResult | null {
  return becomeTransform(deck, slideId, beatId, source, dest, { ...opts, mode: "handoff" });
}

/** Reverse a hand-off atomically, retaining authored timing/style and followers.
 * Geometry is supplied by the host, just as for compileSlide's plot diagnostics. */
export function swapBecome(deck: Deck, slideId: Id, trackId: Id, opts: CompileOptions = {}): Id {
  const slide = slideById(deck, slideId);
  const bi = slide?.beats.findIndex(b => b.tracks.some(t => t.id === trackId)) ?? -1;
  const track = slide?.beats[bi]?.tracks.find(t => t.id === trackId);
  if (!slide || !track || track.preset !== "transform" || !isHandoff(track)) throw new Error("Choose a hand-off Become to swap direction.");
  const spec = track.to.become;
  if (spec.ref.group) throw new Error("Groups cannot be Become sources. Choose an object or plot parts.");
  if (spec.ref.members) throw new Error("A set destination cannot be reversed: a Become has one source. Author each reverse hand-off from its own object.");
  if (track.ghostFrom) throw new Error("This track creates a ghost. Keep its birth and author a reverse hand-off in a later step.");
  if (slide.beats[bi].tracks.some(other => other.id !== trackId && familyOf(other) === "transform" && sameRef(trackRef(other), spec.ref)))
    throw new Error("The destination already has a transform in this step.");
  const options = { ...opts, animStyles: deck.animStyles };
  const compiled = compileSlide(slide, deck.stage, options);
  if (!targetOutlines(spec.ref, compiled.sample(bi), { manifest: opts.plotManifest ?? (() => undefined), plotRoot: opts.plotRoot ?? (() => undefined), groups: slide.groups }).length)
    throw new Error("The destination has no outline. Choose another object or plot part.");
  const resolved = compiled.resolvedSlide.beats[bi].tracks.find(t => t.id === trackId)!;
  // Finish all admission checks on private beats before publishing any mutation.
  const candidate = { ...slide, beats: structuredClone(slide.beats) };
  const work = { ...deck, slides: [candidate] };
  const beat = candidate.beats[bi], groups = beat.groups;
  removeTracks(work, slideId, [trackId]);
  const result = becomeTransform(work, slideId, beat.id, spec.ref, trackRef(track), {
    mode: "handoff", pair: spec.pair, reveal: spec.reveal,
    start: resolved.start ?? 0, duration: trackDuration(resolved), easing: resolved.easing,
    compiled: compileSlide(candidate, deck.stage, options),
  });
  if (!result) throw new Error("This hand-off cannot be reversed.");
  const reverse = beat.tracks.find(t => t.id === result.trackId)!;
  const { target, part, parts, selector, to, id, ...how } = track;
  setAnimation(work, slideId, beat.id, { ...how, target: reverse.target, part: reverse.part, parts: reverse.parts,
    selector: reverse.selector, to: reverse.to, id: result.trackId });
  beat.groups = groups;
  for (const follower of beat.tracks) if (follower.anchor?.trackId === trackId)
    setTrackAnchor(work, slideId, follower.id!, { ...follower.anchor, trackId: result.trackId });
  slide.beats = candidate.beats;
  return result.trackId;
}

/** The cascade-editable timing fields of one track at session start. */
export interface TrackCascadeBaseline {
  curve?: Curve;
  easing?: EasingToken;
  anchor?: Track["anchor"];
  start?: number;
  duration?: number;
  influence?: Influence;
  stagger?: Stagger;
  arc?: number;
}

/** Cascade one timing property across the given tracks of one slide: the
 *  track at rank k gets `value ⊕ delta·step_k` (step = k with firstFixed,
 *  else k+1). Order: "timeline" (beat index, then lane index — default) or
 *  "list" (the trackIds order, i.e. the animator's selection order).
 *  Same ABSOLUTE-FROM-BASELINE law as ops.cascadeElements: the editable
 *  timing fields are restored from `baseline` (default: snapshot now) before
 *  targets are written, so live re-previews are idempotent and a mid-session
 *  property switch reverts the previous property's writes. Clamps match the
 *  animator's own floors (start ≥ 0, duration ≥ 50 ms, influence 0–100,
 *  perMs ≥ 0); `stagger.perMs` applies only to tracks that HAVE a stagger —
 *  others are excluded before ranking. Returns the count written. */
export function cascadeTracks(
  deck: Deck,
  slideId: Id,
  trackIds: Id[],
  spec: TrackCascadeSpec,
  baseline?: Map<Id, TrackCascadeBaseline>,
): number {
  const s = slideById(deck, slideId);
  if (!s) return 0;
  const want = new Set(trackIds);
  const found: { t: Track; beatIdx: number; lane: number }[] = [];
  s.beats.forEach((b, bi) => {
    b.tracks.forEach((t, li) => {
      if (t.id && want.has(t.id)) found.push({ t, beatIdx: bi, lane: li });
    });
  });
  if (!found.length) return 0;
  const base = baseline ?? new Map<Id, TrackCascadeBaseline>();
  for (const { t } of found) {
    if (!t.id) continue;
    if (!base.has(t.id))
      base.set(t.id, {
        anchor: t.anchor ? { ...t.anchor } : undefined,
        start: t.start,
        duration: t.duration,
        curve: t.curve ? structuredClone(t.curve) : undefined,
        easing: t.easing,
        influence: t.influence ? { ...t.influence } : undefined,
        stagger: t.stagger ? { ...t.stagger } : undefined,
        arc: t.arc,
      });
    const b0 = base.get(t.id)!;
    if (b0.arc === undefined) delete t.arc; else t.arc = b0.arc;
    if (b0.anchor === undefined) delete t.anchor; else t.anchor = { ...b0.anchor };
    if (b0.start === undefined) delete t.start;
    else t.start = b0.start;
    if (b0.duration === undefined) delete t.duration;
    else t.duration = b0.duration;
    if (b0.curve === undefined) delete t.curve; else t.curve = structuredClone(b0.curve);
    if (b0.easing === undefined) delete t.easing; else t.easing = b0.easing;
    if (b0.influence === undefined) delete t.influence;
    else t.influence = { ...b0.influence };
    if (b0.stagger === undefined) delete t.stagger;
    else t.stagger = { ...b0.stagger };
  }
  let list = found.filter(({ t }) => (familyOf(t) !== "media" || spec.property === "start") && (spec.property !== "curve.bounce" || resolveTrack(t, deck).curve?.kind === "spring") && (spec.property.startsWith("stagger.") ? !!resolveTrack(t, deck).stagger : spec.property === "arc" ? familyOf(t) === "transform" : true));
  if (spec.order === "list") {
    const pos = new Map(trackIds.map((id, i) => [id, i] as const));
    list.sort((a, b) => (pos.get(a.t.id!) ?? 0) - (pos.get(b.t.id!) ?? 0));
  } else {
    list.sort((a, b) => a.beatIdx - b.beatIdx || a.lane - b.lane);
  }
  if (spec.reverse) list.reverse();
  for (let rank = 0; rank < list.length; rank++) {
    const t = list[rank].t;
    const step = stepOf(rank, spec.firstFixed);
    const b0 = resolveTrack(t, deck);
    switch (spec.property) {
      case "start":
        if (t.anchor) t.anchor.offsetMs = cascadeValue(t.anchor.offsetMs ?? 0, spec, step);
        else t.start = clampTrackValue("start", cascadeValue(b0.start ?? 0, spec, step));
        break;
      case "duration":
        t.duration = clampTrackValue("duration", cascadeValue(trackDuration(b0), spec, step));
        break;
      case "influence.in":
      case "influence.out": {
        const side = spec.property === "influence.in" ? "in" : "out";
        const inf: Influence = { in: b0.influence?.in ?? 0, out: b0.influence?.out ?? 0 };
        inf[side] = clampTrackValue(spec.property, cascadeValue(inf[side], spec, step));
        // Both zero ⇒ no velocity profile at all (PropertiesPane parity).
        setTrackCurve(deck, slideId, t.id!, !inf.in && !inf.out ? null : { influence: inf });
        break;
      }
      case "curve.bounce": {
        if (b0.curve?.kind === "spring") setTrackCurve(deck, slideId, t.id!, {
          ...b0.curve, bounce: clampTrackValue("curve.bounce", cascadeValue(b0.curve.bounce, spec, step)),
        });
        break;
      }
      case "arc":
        setTrackArc(t, clampTrackValue("arc", cascadeValue(b0.arc ?? 0, spec, step)));
        break;
      case "stagger.totalMs":
      case "stagger.perMs": {
        const key = spec.property === "stagger.totalMs" ? "totalMs" : "perMs";
        t.stagger = patchStagger(b0.stagger, { [key]: clampTrackValue(spec.property, cascadeValue(b0.stagger?.[key] ?? 0, spec, step)) });
        break;
      }
    }
  }
  return list.length;
}

export function removeAnimation(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  match: { target: string; part?: string; selector?: Track["selector"] },
): void {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return;
  // Deliberately FAMILY-BLIND (unlike tracksMatch): "remove the animation on
  // this object/part" means every family — an appearance and its sibling
  // transform both go. Family scoping exists for add/replace, not removal.
  const want = trackKey({ target: match.target, part: match.part, selector: match.selector });
  const sameSig = (t: Track) => trackKey(t) === want;
  ensureTrackIds(deck);
  removeTracks(deck, slideId, b.tracks.filter(sameSig).flatMap(t => t.id ? [t.id] : []));
}

// ---------------------------------------------------------------------------
// Track groups — beat-local, collapsible animator lanes (presentational; the
// player never reads them).
// ---------------------------------------------------------------------------

/** Drop group defs no track references and groupIds no def backs. Keeps the
 *  registry tight across deletes/moves; empty `groups` arrays are removed. */
export function gcTrackGroups(beat: Beat): void {
  if (!beat.groups?.length) {
    if (beat.groups) delete beat.groups;
    // strip dangling refs even when the registry is gone
    for (const t of beat.tracks) if (t.groupId) delete t.groupId;
    return;
  }
  const used = new Set<Id>();
  for (const t of beat.tracks) if (t.groupId) used.add(t.groupId);
  beat.groups = beat.groups.filter((g) => used.has(g.id));
  const live = new Set(beat.groups.map((g) => g.id));
  for (const t of beat.tracks) if (t.groupId && !live.has(t.groupId)) delete t.groupId;
  if (!beat.groups.length) delete beat.groups;
}

/** Group tracks (by id) on one beat under a new labeled TrackGroup. Tracks
 *  leave any previous group; the grouped lanes are spliced ADJACENT (in their
 *  current relative order, at the first member's lane) so the group renders as
 *  one contiguous run. Returns the new group id, or null. */
export function groupTracks(deck: Deck, slideId: Id, beatId: Id, trackIds: Id[], label?: string): Id | null {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return null;
  const want = new Set(trackIds);
  const members = b.tracks.filter((t) => t.id && want.has(t.id));
  if (members.length < 1) return null;
  const g: TrackGroup = { id: newId("tgrp"), label: label ?? "Group" };
  b.groups = [...(b.groups ?? []), g];
  for (const t of members) t.groupId = g.id;
  // splice members contiguous at the first member's position
  const first = b.tracks.findIndex((t) => t.id && want.has(t.id));
  const rest = b.tracks.filter((t) => !(t.id && want.has(t.id)));
  const at = Math.min(first, rest.length);
  rest.splice(at, 0, ...members);
  b.tracks = rest;
  gcTrackGroups(b);
  return g.id;
}

/** Dissolve the groups the given tracks belong to (members become loose). */
export function ungroupTracks(deck: Deck, slideId: Id, beatId: Id, trackIds: Id[]): void {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b || !b.groups?.length) return;
  const want = new Set(trackIds);
  const gone = new Set<Id>();
  for (const t of b.tracks) if (t.id && want.has(t.id) && t.groupId) gone.add(t.groupId);
  for (const t of b.tracks) if (t.groupId && gone.has(t.groupId)) delete t.groupId;
  gcTrackGroups(b);
}

/** Patch one TrackGroup (label / collapsed). */
export function setTrackGroup(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  groupId: Id,
  patch: { label?: string; collapsed?: boolean },
): void {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  const g = b?.groups?.find((x) => x.id === groupId);
  if (!g) return;
  if (patch.label != null) g.label = patch.label;
  if (patch.collapsed != null) {
    if (patch.collapsed) g.collapsed = true;
    else delete g.collapsed;
  }
}

/** Backfill stable ids onto any track that lacks one. Idempotent; called at
 *  load so the editor can key/select tracks reliably. Mutates + returns. */
export function ensureTrackIds(deck: Deck): Deck {
  for (const s of deck.slides) for (const b of s.beats) for (const t of b.tracks) if (!t.id) t.id = newId("track");
  return deck;
}

/** 0.2/0.3/0.4/0.5 → 0.6: a version stamp — older decks contain none of the
 *  0.5 video or 0.6 animation-v2 additions, and every 0.6 field is additive.
 *  Legacy morph names normalize below. Unknown legacy easing strings are
 *  dropped so the player's fallback survives the stricter disk enum.
 *  Anything else (0.1.x, garbage) passes through untouched and fails
 *  validation downstream exactly as before. Mutates + returns. */
export function migrateDeck(deck: Deck): Deck {
  if (typeof deck?.schemaVersion === "string" && /^0\.[2345]\./.test(deck.schemaVersion)) {
    deck.schemaVersion = DECK_SCHEMA_VERSION;
  }
  // The legacy data-space `morph` preset IS a transform (Become, content
  // half only). Normalize the name; keep the authored timing (its old default
  // duration was 1200 ms) so playback is byte-for-byte the same motion.
  for (const s of deck?.slides ?? []) for (const b of s.beats ?? []) for (const t of b.tracks ?? []) {
    // Legacy hand-written strings used the player's fallback. Keep the disk
    // enum strict without quarantining those otherwise valid decks.
    if (typeof t.easing === "string" && !EASING_TOKENS.includes(t.easing)) delete t.easing;
    if ((t.preset as string) === "morph") {
      t.preset = "transform";
      if (t.duration == null) t.duration = 1200;
      t.to = t.to ?? {};
      if (!t.to.state) t.to.state = {};
    }
  }
  for (const style of deck?.animStyles ?? []) {
    if (typeof style.track?.easing === "string" && !EASING_TOKENS.includes(style.track.easing)) delete style.track.easing;
  }
  return deck;
}

/** THE deck-load chokepoint — every seam that reads a deck from disk (GUI
 *  slideBridge.readDeck, flux-core loadDeck) runs this: migrate (0.2–0.5 →
 *  0.6 stamp) then id normalization. A 0.1.x deck is untouched here and
 *  fails validation downstream (quarantine — the sanctioned clean break);
 *  newer-than-ours files are refused earlier by the forward-version guard. */
export function normalizeDeck(deck: Deck): Deck {
  return ensureTrackIds(migrateDeck(deck));
}

/** Beat tracks whose target element no longer exists on their slide (excluding
 *  the virtual @camera/@stage targets). Tolerated at play time (the player
 *  no-ops), surfaced by the animator + deck diagnostics, never auto-pruned. */
export function danglingTrackTargets(deck: Deck): { slideId: Id; beatId: Id; trackId?: Id; target: string }[] {
  const out: { slideId: Id; beatId: Id; trackId?: Id; target: string }[] = [];
  for (const s of deck.slides) {
    const live = new Set(s.elements.map((e) => e.id));
    for (const b of s.beats)
      for (const t of b.tracks) {
        if (t.target.startsWith("@") || live.has(t.target)) continue;
        out.push({ slideId: s.id, beatId: b.id, ...(t.id ? { trackId: t.id } : {}), target: t.target });
      }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assets — deck-local media registry (figure Asset shape).
// ---------------------------------------------------------------------------
export interface AddAssetOpts {
  id?: Id;
  name?: string;
  kind: Asset["kind"];
  /** Deck-relative path, e.g. "assets/photo.png". */
  path: string;
  naturalWidth: number;
  naturalHeight: number;
  dpi?: number;
  durationMs?: number;
  hasAudio?: boolean;
  sourcePath?: string;
}

export function addAsset(deck: Deck, opts: AddAssetOpts): Id {
  const id = opts.id ?? newId("asset");
  deck.assets.push({
    id,
    name: opts.name ?? opts.path.split("/").pop() ?? id,
    kind: opts.kind,
    path: opts.path,
    naturalWidth: opts.naturalWidth,
    naturalHeight: opts.naturalHeight,
    ...(opts.dpi != null ? { dpi: opts.dpi } : {}),
    ...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
    ...(opts.hasAudio != null ? { hasAudio: opts.hasAudio } : {}),
    ...(opts.sourcePath != null ? { sourcePath: opts.sourcePath } : {}),
  });
  return id;
}
