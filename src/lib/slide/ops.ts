// ---------------------------------------------------------------------------
// Flux Slide — the one pure mutation core (the agent-parity keystone).
//
// Mirrors src/lib/ops.ts exactly: every structural edit to a deck is a PURE
// function `(deck: Deck, args) => result` that mutates the plain types.ts model
// in place — no Svelte stores, no DOM. Three callers share this one core so that
// "no capability is GUI-only":
//   • the GUI:         deckStore commit → ops.xxx(deck, args)
//   • flux-core:       reads deck.json, calls ops.xxx, writes it back
//   • the live bridge: maps a slide command → the same ops.xxx
//
// Dependency-light: imports only the slide types, the figure types/constructors
// it reuses (makePlotPanel/makeImagePanel — a plot on a slide is the same
// SemanticPlotElement), the id leaf, and the theme defaults.
// ---------------------------------------------------------------------------

import type { Element, Id, RectElement, EllipseElement, LineElement } from "../types";
import { newId } from "../ids";
import { makePlotPanel, makeImagePanel, type Box } from "../ops";
import { DEFAULT_THEME_ID } from "./theme";
import {
  DECK_SCHEMA_VERSION,
  type Deck,
  type Slide,
  type Beat,
  type Track,
  type SlideElement,
  type TextBoxElement,
  type TextBlock,
  type MathElement,
  type VideoElement,
  type EmbedFigureElement,
  type LayoutId,
  type StageSize,
  type Camera,
  type TransitionKind,
} from "./types";

// 16:9 at a comfortable authoring resolution (also 1920×1080, 4:3 via setStageSize).
export const DEFAULT_STAGE: StageSize = { width: 1280, height: 720 };

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
export function findElement(
  deck: Deck,
  elId: Id,
): { slide: Slide; el: SlideElement } | null {
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

/** Construct a new, valid, empty deck (one blank title slide by default). The
 *  single source for a blank deck — the GUI and agents both build through it. */
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
    assets: [],
    slides: [],
  };
  if (opts.withTitleSlide !== false) addSlide(deck, { layout: "title", name: "Title" });
  return deck;
}

export function setDeckMeta(
  deck: Deck,
  patch: { title?: string; theme?: string },
): void {
  if (patch.title != null) deck.title = patch.title;
  if (patch.theme != null) deck.theme = patch.theme;
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
  return slide;
}

/** Delete a slide. Returns the id that should become active next (or null). */
export function deleteSlide(deck: Deck, slideId: Id): { nextActiveId: Id | null } {
  const i = deck.slides.findIndex((s) => s.id === slideId);
  if (i < 0) return { nextActiveId: deck.slides[0]?.id ?? null };
  deck.slides.splice(i, 1);
  const next = deck.slides[i] ?? deck.slides[i - 1] ?? null;
  return { nextActiveId: next?.id ?? null };
}

/** Duplicate a slide (all elements + beats), remapping element/block/beat ids
 *  and rewriting any track targets that referenced the old element ids. */
export function duplicateSlide(deck: Deck, slideId: Id): Id | null {
  const src = slideById(deck, slideId);
  if (!src) return null;
  const i = deck.slides.findIndex((s) => s.id === slideId);
  const idRemap = new Map<Id, Id>();
  const copy: Slide = structuredClone(src);
  copy.id = newId("slide");
  copy.name = `${src.name ?? "Slide"} copy`;
  for (const el of copy.elements) {
    const nid = newId(el.type);
    idRemap.set(el.id, nid);
    el.id = nid;
  }
  for (const beat of copy.beats) {
    beat.id = newId("beat");
    for (const t of beat.tracks) {
      const mapped = idRemap.get(t.target);
      if (mapped) t.target = mapped;
    }
  }
  deck.slides.splice(i + 1, 0, copy);
  return copy.id;
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
// Element constructors + add (pure)
// ---------------------------------------------------------------------------
const box = (b: Box, dw: number, dh: number) => ({
  x: b.x ?? 80,
  y: b.y ?? 80,
  width: b.width ?? dw,
  height: b.height ?? dh,
});

export interface TextBoxOpts extends Box {
  blocks?: TextBlock[];
  /** Convenience: a single block of text (alternative to `blocks`). */
  text?: string;
  align?: TextBoxElement["align"];
  valign?: TextBoxElement["valign"];
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  lineHeight?: number;
  autoFit?: boolean;
}

export function makeBlock(text: string, opts: Partial<TextBlock> = {}): TextBlock {
  return {
    id: opts.id ?? newId("blk"),
    text,
    ...(opts.level != null ? { level: opts.level } : {}),
    ...(opts.marker != null ? { marker: opts.marker } : {}),
    ...(opts.emphasis != null ? { emphasis: opts.emphasis } : {}),
  };
}

export function makeTextBox(opts: TextBoxOpts = {}): TextBoxElement {
  const g = box(opts, 560, 120);
  const blocks =
    opts.blocks ?? (opts.text != null ? [makeBlock(opts.text)] : [makeBlock("")]);
  const el: TextBoxElement = {
    type: "textBox",
    id: newId("textBox"),
    ...g,
    rotation: 0,
    blocks,
  };
  if (opts.align != null) el.align = opts.align;
  if (opts.valign != null) el.valign = opts.valign;
  if (opts.color != null) el.color = opts.color;
  if (opts.fontFamily != null) el.fontFamily = opts.fontFamily;
  if (opts.fontSize != null) el.fontSize = opts.fontSize;
  if (opts.fontWeight != null) el.fontWeight = opts.fontWeight;
  if (opts.fontStyle != null) el.fontStyle = opts.fontStyle;
  if (opts.lineHeight != null) el.lineHeight = opts.lineHeight;
  if (opts.autoFit != null) el.autoFit = opts.autoFit;
  return el;
}

export interface MathOpts extends Box {
  tex: string;
  display?: boolean;
  color?: string;
  fontSize?: number;
}
export function makeMath(opts: MathOpts): MathElement {
  const g = box(opts, 360, 80);
  const el: MathElement = { type: "math", id: newId("math"), ...g, rotation: 0, tex: opts.tex };
  if (opts.display != null) el.display = opts.display;
  if (opts.color != null) el.color = opts.color;
  if (opts.fontSize != null) el.fontSize = opts.fontSize;
  return el;
}

export interface VideoOpts extends Box {
  assetId: Id;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  controls?: boolean;
  poster?: Id;
}
export function makeVideo(opts: VideoOpts): VideoElement {
  const g = box(opts, 640, 360);
  const el: VideoElement = { type: "video", id: newId("video"), ...g, rotation: 0, assetId: opts.assetId };
  if (opts.autoplay != null) el.autoplay = opts.autoplay;
  if (opts.loop != null) el.loop = opts.loop;
  if (opts.muted != null) el.muted = opts.muted;
  if (opts.controls != null) el.controls = opts.controls;
  if (opts.poster != null) el.poster = opts.poster;
  return el;
}

export interface EmbedFigureOpts extends Box {
  figureId: string;
  fit?: EmbedFigureElement["fit"];
}
export function makeEmbedFigure(opts: EmbedFigureOpts): EmbedFigureElement {
  const g = box(opts, 640, 480);
  const el: EmbedFigureElement = {
    type: "embedFigure",
    id: newId("embedFigure"),
    ...g,
    rotation: 0,
    figureId: opts.figureId,
  };
  if (opts.fit != null) el.fit = opts.fit;
  return el;
}

/** Append a fully-formed element to a slide; returns its id (or null). */
export function addElement(deck: Deck, slideId: Id, el: SlideElement): Id | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  s.elements.push(el);
  return el.id;
}

export function addTextBox(deck: Deck, slideId: Id, opts: TextBoxOpts = {}): Id | null {
  return addElement(deck, slideId, makeTextBox(opts));
}

/** Append a bullet block to an existing text box (or to a fresh one if id omitted). */
export function addBullet(
  deck: Deck,
  slideId: Id,
  textBoxId: Id,
  text: string,
  opts: Partial<TextBlock> = {},
): Id | null {
  const found = findElement(deck, textBoxId);
  if (!found || found.el.type !== "textBox") return null;
  const blk = makeBlock(text, { marker: "bullet", ...opts });
  found.el.blocks.push(blk);
  return blk.id;
}

export function addMath(deck: Deck, slideId: Id, opts: MathOpts): Id | null {
  return addElement(deck, slideId, makeMath(opts));
}

export function addVideo(deck: Deck, slideId: Id, opts: VideoOpts): Id | null {
  return addElement(deck, slideId, makeVideo(opts));
}

export function addEmbedFigure(deck: Deck, slideId: Id, opts: EmbedFigureOpts): Id | null {
  return addElement(deck, slideId, makeEmbedFigure(opts));
}

/** Drop a semantic plot on a slide — the SAME SemanticPlotElement the figure
 *  editor uses (so its parts are addressable + animation-ready). Reuses the
 *  figure constructor. */
export function addPlotToSlide(
  deck: Deck,
  slideId: Id,
  opts: { assetId: Id; source?: import("../types").SemanticPlotElement["source"]; manifestRef?: import("../types").SemanticPlotElement["manifestRef"] } & Box,
): Id | null {
  return addElement(deck, slideId, makePlotPanel(opts.assetId, opts, opts.source, opts.manifestRef));
}

// --- vector shapes (figure RectElement/EllipseElement/LineElement reused) -----
export function makeRect(opts: Box & { fill?: string; stroke?: string; strokeWidth?: number; cornerRadius?: number } = {}): RectElement {
  const g = box(opts, 240, 160);
  return {
    type: "rect", id: newId("rect"), ...g, rotation: 0,
    fill: opts.fill ?? "var(--sl-accent)", stroke: opts.stroke ?? "transparent",
    strokeWidth: opts.strokeWidth ?? 0, cornerRadius: opts.cornerRadius ?? 0,
  };
}
export function makeEllipse(opts: Box & { fill?: string; stroke?: string; strokeWidth?: number } = {}): EllipseElement {
  const g = box(opts, 200, 200);
  return {
    type: "ellipse", id: newId("ellipse"), ...g, rotation: 0,
    fill: opts.fill ?? "var(--sl-accent)", stroke: opts.stroke ?? "transparent", strokeWidth: opts.strokeWidth ?? 0,
  };
}
export function makeLine(opts: Box & { stroke?: string; strokeWidth?: number; arrowEnd?: boolean } = {}): LineElement {
  const g = box(opts, 240, 0);
  return {
    type: "line", id: newId("line"), ...g, height: opts.height ?? 0, rotation: 0,
    x1: 0, y1: 0, x2: g.width, y2: 0,
    stroke: opts.stroke ?? "var(--sl-text)", strokeWidth: opts.strokeWidth ?? 3,
    arrowStart: false, arrowEnd: opts.arrowEnd ?? false,
  };
}
export function addRect(deck: Deck, slideId: Id, opts: Parameters<typeof makeRect>[0] = {}): Id | null {
  return addElement(deck, slideId, makeRect(opts));
}
export function addEllipse(deck: Deck, slideId: Id, opts: Parameters<typeof makeEllipse>[0] = {}): Id | null {
  return addElement(deck, slideId, makeEllipse(opts));
}
export function addLine(deck: Deck, slideId: Id, opts: Parameters<typeof makeLine>[0] = {}): Id | null {
  return addElement(deck, slideId, makeLine(opts));
}

/** Drop an imported image (deck asset) on a slide. */
export function addImageToSlide(
  deck: Deck,
  slideId: Id,
  opts: { assetId: Id } & Box,
): Id | null {
  return addElement(deck, slideId, makeImagePanel(opts.assetId, "image", opts) as Element);
}

/** Update an element's geometry/transform (drag/resize/rotate from the editor). */
export function setElementBox(
  deck: Deck,
  elId: Id,
  patch: { x?: number; y?: number; width?: number; height?: number; rotation?: number; opacity?: number; locked?: boolean },
): void {
  const found = findElement(deck, elId);
  if (!found) return;
  const el = found.el;
  if (patch.x != null) el.x = patch.x;
  if (patch.y != null) el.y = patch.y;
  if (patch.width != null) el.width = patch.width;
  if (patch.height != null) el.height = patch.height;
  if (patch.rotation != null) el.rotation = patch.rotation;
  if (patch.opacity != null) el.opacity = patch.opacity;
  if (patch.locked != null) el.locked = patch.locked;
}

export function deleteElements(deck: Deck, ids: Id[]): void {
  const set = new Set(ids);
  for (const s of deck.slides) {
    s.elements = s.elements.filter((e) => !set.has(e.id));
    // Drop any tracks that targeted a removed element.
    for (const b of s.beats) b.tracks = b.tracks.filter((t) => !set.has(t.target));
  }
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
  const at = opts.at;
  if (at != null && at >= 0 && at <= s.beats.length) s.beats.splice(at, 0, beat);
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
  if (!s) return;
  const byId = new Map(s.beats.map((b) => [b.id, b] as const));
  const seen = new Set<Id>();
  const next: Beat[] = [];
  for (const id of order) {
    const b = byId.get(id);
    if (b && !seen.has(id)) {
      next.push(b);
      seen.add(id);
    }
  }
  for (const b of s.beats) if (!seen.has(b.id)) next.push(b);
  s.beats = next;
}

/** Two tracks "match" (and thus replace, rather than stack) when they target the
 *  same element + the same part/selector signature. */
function tracksMatch(a: Track, b: Track): boolean {
  if (a.target !== b.target) return false;
  if ((a.part ?? "") !== (b.part ?? "")) return false;
  return JSON.stringify(a.selector ?? null) === JSON.stringify(b.selector ?? null);
}

/** Add or replace an animation track on a beat (the keystone animation op). */
export function setAnimation(deck: Deck, slideId: Id, beatId: Id, track: Track): boolean {
  const s = slideById(deck, slideId);
  const b = s && beatById(s, beatId);
  if (!b) return false;
  const i = b.tracks.findIndex((t) => tracksMatch(t, track));
  if (i >= 0) b.tracks[i] = track;
  else b.tracks.push(track);
  return true;
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
  const probe: Track = { target: match.target, part: match.part, selector: match.selector };
  b.tracks = b.tracks.filter((t) => !tracksMatch(t, probe));
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
export interface AddAssetOpts {
  id?: Id;
  kind: import("./types").DeckAsset["kind"];
  path: string;
  naturalWidth?: number;
  naturalHeight?: number;
}
export function addAsset(deck: Deck, opts: AddAssetOpts): Id {
  const id = opts.id ?? newId("asset");
  deck.assets.push({
    id,
    kind: opts.kind,
    path: opts.path,
    ...(opts.naturalWidth != null ? { naturalWidth: opts.naturalWidth } : {}),
    ...(opts.naturalHeight != null ? { naturalHeight: opts.naturalHeight } : {}),
  });
  return id;
}
