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

import type { Asset, Element, Id, SemanticPlotElement } from "../types";
import { newId } from "../ids";
import { makePlotPanel, makeImagePanel, makeText, mergePartOverride, type Box, type TextOpts } from "../ops";
import { FLEXOKI } from "../flexoki";
import { DEFAULT_TEXT_STYLES } from "../migrate";
import { DEFAULT_THEME_ID } from "./theme";
import { cloneContentWithFreshIds, placeContentOnStage } from "./deckProject";
import { familyOf } from "./family";
import {
  DECK_SCHEMA_VERSION,
  type Deck,
  type Slide,
  type Beat,
  type Track,
  type TrackGroup,
  type LayoutId,
  type StageSize,
  type Camera,
  type TransitionKind,
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
    defaults: { transition: "fade", buildEasing: "smooth", advance: "click" },
    palette: [],
    colorGroups: structuredClone(FLEXOKI),
    textStyles: structuredClone(DEFAULT_TEXT_STYLES),
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
  deck.theme = theme;
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
    addSlideText(deck, slideId, { text, ...b, ...style });
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
  const { elements, groups, idRemap } = cloneContentWithFreshIds(src.elements, src.groups);
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
    for (const t of beat.tracks) {
      // Every track carries a stable id; a duplicated slide's tracks must get
      // FRESH ids or they collide with the source slide's.
      t.id = newId("track");
      const mapped = idRemap.get(t.target);
      if (mapped) t.target = mapped;
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
  /** The slide verbatim (id/name ignored at insert; beats/tracks remapped). */
  slide: Slide;
  assets?: SlidePresetAssetEntry[];
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
  const assetRemap = new Map<Id, Id>();
  for (const entry of snap.assets ?? []) {
    const aid = entry.asset.id;
    if (deck.assets.some((a) => a.id === aid)) continue; // same source asset, already here
    const nid = newId("asset");
    assetRemap.set(aid, nid);
    deck.assets.push({ ...structuredClone(entry.asset), id: nid, path: `assets/${nid}.${entry.asset.kind}` });
  }
  const { elements, groups, idRemap } = cloneContentWithFreshIds(snap.slide.elements, snap.slide.groups);
  for (const el of elements) {
    const withAsset = el as { assetId?: Id };
    if (withAsset.assetId && assetRemap.has(withAsset.assetId)) withAsset.assetId = assetRemap.get(withAsset.assetId)!;
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
    for (const t of beat.tracks) {
      t.id = newId("track");
      const mapped = idRemap.get(t.target);
      if (mapped) t.target = mapped;
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
  return addElement(deck, slideId, makeText(opts.text, opts, opts, false));
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
  copy.id = newId("beat");
  if (copy.label) copy.label += " copy";
  for (const t of copy.tracks) t.id = newId("track");
  remapBeatGroupIds(copy);
  s.beats.splice(i + 1, 0, copy);
  return copy;
}

/** Delete a beat (never removes the resting beat 0). */
export function deleteBeat(deck: Deck, slideId: Id, beatId: Id): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const i = s.beats.findIndex((b) => b.id === beatId);
  if (i <= 0) return; // keep beat 0 (the resting state)
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

/** Move a track into another beat on the same slide (drag a chip across
 *  columns). `at` places it at a lane index (default: append). Timing (start/
 *  duration/stagger) travels untouched; a beat-local group membership is
 *  dropped on a CROSS-beat move (groups live per beat). */
export function moveTrackToBeat(deck: Deck, slideId: Id, trackId: Id, toBeatId: Id, at?: number): boolean {
  const s = slideById(deck, slideId);
  if (!s) return false;
  const to = beatById(s, toBeatId);
  if (!to) return false;
  for (const b of s.beats) {
    const i = b.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
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

/** Deep-copy a track in place (inserted right after the original, fresh id). */
export function duplicateTrack(deck: Deck, slideId: Id, trackId: Id): Id | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  for (const b of s.beats) {
    const i = b.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
    const copy = structuredClone(b.tracks[i]);
    copy.id = newId("track");
    b.tracks.splice(i + 1, 0, copy);
    return copy.id;
  }
  return null;
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

/** Author a data-space morph: plot element `plotElId` tweens into project plot
 *  `toAssetId` on beat `beatId`. Pure model write — the caller gates
 *  compatibility (see autobuild.listMorphCandidates); the player additionally
 *  holds at A for incompatible pairs at play time. */
export function setMorphTrack(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  plotElId: Id,
  toAssetId: Id,
  opts: {
    duration?: number;
    easing?: import("./types").EasingToken;
    start?: number;
    /** Explicit target source paths (project-relative) — persisted on the
     *  track so load/export resolvers don't fall back to path guessing. */
    svgPath?: string;
    manifestPath?: string;
  } = {},
): boolean {
  return setAnimation(deck, slideId, beatId, {
    id: newId("track"),
    target: plotElId,
    preset: "morph",
    to: {
      assetId: toAssetId,
      ...(opts.svgPath ? { svgPath: opts.svgPath } : {}),
      ...(opts.manifestPath ? { manifestPath: opts.manifestPath } : {}),
    },
    duration: opts.duration ?? 1200,
    easing: opts.easing ?? "smooth",
    ...(opts.start != null ? { start: opts.start } : {}),
  });
}

/** Two tracks "match" (and thus replace, rather than stack) when they animate
 *  in the same FAMILY (family.ts) on the same target with the same part/
 *  selector signature — so an appearance and a transform coexist on one
 *  object in one beat. Transforms are whole-element and unique per target:
 *  two transform-family tracks match on target alone (the "max one transform
 *  per target per beat" law — chaining happens across beats). */
function tracksMatch(a: Track, b: Track): boolean {
  if (a.target !== b.target) return false;
  const fam = familyOf(a);
  if (fam !== familyOf(b)) return false;
  if (fam === "transform") return true;
  if ((a.part ?? "") !== (b.part ?? "")) return false;
  return JSON.stringify(a.selector ?? null) === JSON.stringify(b.selector ?? null);
}

/** Add or replace an animation track on a beat (the keystone animation op). */
export function setAnimation(deck: Deck, slideId: Id, beatId: Id, track: Track): boolean {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return false;
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
    };
  } else b.tracks.push({ ...track, id: track.id ?? newId("track") });
  return true;
}

/** Add (or update) the ONE transform track for `targetId` on a beat — the
 *  ergonomic form agents and the GUI use so nobody hand-builds `to.state`
 *  diffs. Merges `state` keys over the existing patch (a key of undefined is
 *  skipped; an explicit null persists as "delete this prop at t2");
 *  `replaceState` swaps the whole patch. Timing/easing patch only when given.
 *  Returns the track (created or updated), or null. */
export function setTransform(
  deck: Deck,
  slideId: Id,
  beatId: Id,
  targetId: Id,
  opts: {
    state?: Record<string, unknown>;
    replaceState?: boolean;
    start?: number;
    duration?: number;
    easing?: import("./types").EasingToken;
    influence?: import("./types").Influence;
    /** plot content half: morph target asset (+ explicit source paths). */
    toAssetId?: Id;
    svgPath?: string;
    manifestPath?: string;
  } = {},
): Track | null {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return null;
  let t = b.tracks.find((x) => x.target === targetId && familyOf(x) === "transform");
  if (!t) {
    t = { id: newId("track"), target: targetId, preset: "transform", duration: 600, easing: "smooth", to: { state: {} } };
    b.tracks.push(t);
  } else if (t.preset === "morph") {
    // Adopt a legacy morph into the transform form (same family, richer patch).
    t.preset = "transform";
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
  if (opts.toAssetId != null) t.to.assetId = opts.toAssetId;
  if (opts.svgPath != null) t.to.svgPath = opts.svgPath;
  if (opts.manifestPath != null) t.to.manifestPath = opts.manifestPath;
  if (opts.start != null) t.start = opts.start;
  if (opts.duration != null) t.duration = opts.duration;
  if (opts.easing != null) t.easing = opts.easing;
  if (opts.influence != null) t.influence = opts.influence;
  return t;
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
  const sameSig = (t: Track) =>
    t.target === match.target &&
    (t.part ?? "") === (match.part ?? "") &&
    JSON.stringify(t.selector ?? null) === JSON.stringify(match.selector ?? null);
  b.tracks = b.tracks.filter((t) => !sameSig(t));
  gcTrackGroups(b);
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

/** 0.2.0 → 0.3.0: a pure stamp — every 0.2.0 document is already valid 0.3.0
 *  (the rework's additions are all optional fields with absent-means-legacy
 *  semantics, and defaults reproduce 0.2.0 playback byte-identically).
 *  Anything else (0.1.x, garbage) passes through untouched and fails
 *  validation downstream exactly as before. Mutates + returns. */
export function migrateDeck(deck: Deck): Deck {
  if (typeof deck?.schemaVersion === "string" && deck.schemaVersion.startsWith("0.2.")) {
    deck.schemaVersion = DECK_SCHEMA_VERSION;
  }
  return deck;
}

/** THE deck-load chokepoint — every seam that reads a deck from disk (GUI
 *  slideBridge.readDeck, flux-core loadDeck) runs this: migrate (0.2.0 →
 *  0.3.0 stamp) then id normalization. A 0.1.x deck is untouched here and
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
  kind: "png" | "svg";
  /** Deck-relative path, e.g. "assets/photo.png". */
  path: string;
  naturalWidth: number;
  naturalHeight: number;
  dpi?: number;
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
  });
  return id;
}
