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

import type { Element, Id, RectElement, EllipseElement, LineElement, SemanticPlotElement } from "../types";
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
  /** Pre-place editable starter text boxes for the layout (the GUI "Add slide"
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

/** Pre-place editable placeholder text boxes for a layout (A16) — the "Layout"
 *  choice now actually scaffolds the slide. Coordinates are fractions of the
 *  stage so any aspect ratio lands sensibly. `full-bleed`/`blank` stay empty
 *  (they're for a single dropped figure/plot or a hand-built slide). */
export function applyLayoutStarters(deck: Deck, slideId: Id, layout: LayoutId): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const W = deck.stage.width, H = deck.stage.height;
  const box = (fx: number, fy: number, fw: number, fh: number) => ({ x: Math.round(fx * W), y: Math.round(fy * H), width: Math.round(fw * W), height: Math.round(fh * H) });
  const add = (b: ReturnType<typeof box>, text: string, extra: Partial<TextBoxOpts> = {}) =>
    addTextBox(deck, slideId, { ...b, blocks: [makeBlock(text)], ...extra });
  if (layout === "title") {
    add(box(0.1, 0.34, 0.8, 0.18), "Title", { fontSize: Math.round(H * 0.089), fontWeight: 700, align: "center" });
    add(box(0.1, 0.56, 0.8, 0.1), "Subtitle", { fontSize: Math.round(H * 0.044), align: "center", blocks: [makeBlock("Subtitle", { emphasis: "muted" })] });
  } else if (layout === "section") {
    add(box(0.1, 0.4, 0.8, 0.2), "Section", { fontSize: Math.round(H * 0.078), fontWeight: 700, align: "center" });
  } else if (layout === "content-figure") {
    add(box(0.06, 0.08, 0.88, 0.13), "Title", { fontSize: Math.round(H * 0.061), fontWeight: 700 });
    add(box(0.06, 0.26, 0.42, 0.64), "Point one", {
      fontSize: Math.round(H * 0.042),
      blocks: [makeBlock("Point one", { marker: "bullet" }), makeBlock("Point two", { marker: "bullet" }), makeBlock("Point three", { marker: "bullet" })],
    });
  } else if (layout === "two-column") {
    add(box(0.06, 0.08, 0.88, 0.13), "Title", { fontSize: Math.round(H * 0.061), fontWeight: 700 });
    add(box(0.06, 0.26, 0.42, 0.64), "Left column", { fontSize: Math.round(H * 0.042), blocks: [makeBlock("Left column", { marker: "bullet" })] });
    add(box(0.52, 0.26, 0.42, 0.64), "Right column", { fontSize: Math.round(H * 0.042), blocks: [makeBlock("Right column", { marker: "bullet" })] });
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

/** Duplicate a slide (all elements + beats), remapping element/block/beat ids
 *  and rewriting any track targets that referenced the old element ids. */
export function duplicateSlide(deck: Deck, slideId: Id): Id | null {
  const src = slideById(deck, slideId);
  if (!src) return null;
  const i = deck.slides.findIndex((s) => s.id === slideId);
  const idRemap = new Map<Id, Id>();
  const groupRemap = new Map<Id, Id>();
  const copy: Slide = structuredClone(src);
  copy.id = newId("slide");
  copy.name = `${src.name ?? "Slide"} copy`;
  for (const el of copy.elements) {
    const nid = newId(el.type);
    idRemap.set(el.id, nid);
    el.id = nid;
    // Remap group membership so the copy's elements group with each OTHER, not
    // with the originals (same stable-id-contract concern as track ids below).
    // NOTE (figure-v1 P7/P9): this flat remap is DELIBERATELY not the figure
    // editor's groups.ts cloneGroupsFor — slide decks have no GroupDef registry
    // (no Slide.groups; a slide groupId is pure co-selection, never named or
    // nested), so a fresh shared id per source group is the complete, correct
    // semantics here. Do not port the registry to slides without a model
    // decision. (The named-group trees a slide CAN animate live inside
    // embedFigure elements and belong to the FIGURE, addressed via
    // Track.part = "group:<gid>" — see player.ts resolveNodes.)
    if (el.groupId) {
      let g = groupRemap.get(el.groupId);
      if (!g) { g = newId("grp"); groupRemap.set(el.groupId, g); }
      el.groupId = g;
    }
  }
  for (const beat of copy.beats) {
    beat.id = newId("beat");
    for (const t of beat.tracks) {
      // SLD-10: every track carries a stable id; a duplicated slide's tracks must
      // get FRESH ids or they collide with the source slide's (breaks editor
      // selection / timeline keying).
      t.id = newId("track");
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

/** Inline-edit write path: reconcile a textarea's plain text (one line per block)
 *  back into a TextBox's blocks — preserving each surviving block's id + marker/
 *  emphasis/level; new lines inherit the last block's marker; never goes empty. */
export function setTextBoxText(deck: Deck, elId: Id, text: string): void {
  const found = findElement(deck, elId);
  if (!found || found.el.type !== "textBox") return;
  const el = found.el;
  const lines = text.split("\n");
  // Reconcile block IDENTITY across the edit so per-block animation tracks keep
  // targeting the same line (A18). Pass 1: a new line whose text is UNCHANGED
  // reclaims that exact old block (id + marker/emphasis/level) even if lines were
  // inserted/removed above it. Pass 2: an edited line inherits the nearest
  // still-unclaimed old block positionally (so an in-place edit keeps its id);
  // a genuinely new line mints a fresh id.
  const pool = el.blocks.map((b) => ({ b, used: false }));
  const claim: (TextBlock | undefined)[] = lines.map((line) => {
    const hit = pool.find((p) => !p.used && p.b.text === line);
    if (hit) { hit.used = true; return hit.b; }
    return undefined;
  });
  let cursor = 0;
  el.blocks = lines.map((line, i) => {
    const exact = claim[i];
    if (exact) return { ...exact, text: line };
    while (cursor < pool.length && pool[cursor].used) cursor++;
    const ref = cursor < pool.length ? pool[cursor] : null;
    if (ref) ref.used = true;
    return makeBlock(line, { id: ref?.b.id, marker: ref?.b.marker, emphasis: ref?.b.emphasis, level: ref?.b.level });
  });
  if (!el.blocks.length) el.blocks = [makeBlock("")];
}

/** Inline-edit write path for a math element: set its TeX source. */
export function setMathTex(deck: Deck, elId: Id, tex: string): void {
  const found = findElement(deck, elId);
  if (found && found.el.type === "math") found.el.tex = tex;
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
  /** Scope to one named group inside the figure (group insertables). */
  groupId?: string;
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
  if (opts.groupId != null) el.groupId = opts.groupId;
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

// ---------------------------------------------------------------------------
// Element editing — duplicate / group / z-order / align (multi-select tools)
// ---------------------------------------------------------------------------

/** Deep-clone the given elements (remapping ids; keeping a duplicated group
 *  together under a fresh shared id; re-keying text blocks) and append them,
 *  offset by (dx,dy). Returns the new element ids — the caller selects them. */
export function duplicateElements(deck: Deck, slideId: Id, ids: Id[], dx = 24, dy = 24): Id[] {
  const s = slideById(deck, slideId);
  if (!s) return [];
  const set = new Set(ids);
  const groupRemap = new Map<Id, Id>();
  const idRemap = new Map<Id, Id>(); // original element id → its copy's id
  const out: Id[] = [];
  for (const el of [...s.elements]) {
    if (!set.has(el.id)) continue;
    const copy = structuredClone(el);
    copy.id = newId(el.type);
    copy.x += dx;
    copy.y += dy;
    if (copy.groupId) {
      let g = groupRemap.get(copy.groupId);
      if (!g) { g = newId("group"); groupRemap.set(copy.groupId, g); }
      copy.groupId = g;
    }
    if (copy.type === "textBox") for (const b of copy.blocks) b.id = newId("block");
    s.elements.push(copy);
    idRemap.set(el.id, copy.id);
    out.push(copy.id);
  }
  // SLD-10: carry each duplicated element's animation tracks onto its copy (same slide → beats
  // align 1:1). Fresh track ids keep the stable-id contract; the copy animates like the original.
  carryTracks(s, idRemap);
  return out;
}

/** Append, to every beat, a fresh-id retargeted copy of each track that targets an element in
 *  `idRemap` (original id → new id). Same-slide only, so beats map 1:1. */
function carryTracks(slide: Slide, idRemap: Map<Id, Id>): void {
  if (!idRemap.size) return;
  for (const beat of slide.beats) {
    const add: Track[] = [];
    for (const t of beat.tracks) {
      const nt = idRemap.get(t.target);
      if (nt) add.push({ ...structuredClone(t), id: newId("track"), target: nt });
    }
    beat.tracks.push(...add);
  }
}

/** Clone external elements (from the clipboard) into a slide with fresh ids —
 *  the paste counterpart of duplicateElements. Returns the new ids. SLD-10: optional `tracks`
 *  (captured at copy time, tagged by beat index) are re-attached, retargeted to the copies, at
 *  the same beat index when it exists in the target slide (dropped otherwise — beat structure
 *  differs across slides), so pasting an animated element keeps its animation. */
export function pasteElements(
  deck: Deck,
  slideId: Id,
  els: SlideElement[],
  dx = 24,
  dy = 24,
  tracks: { beatIndex: number; track: Track }[] = [],
): Id[] {
  const s = slideById(deck, slideId);
  if (!s) return [];
  const groupRemap = new Map<Id, Id>();
  const idRemap = new Map<Id, Id>(); // source element id → its copy's id
  const out: Id[] = [];
  for (const src of els) {
    const copy = structuredClone(src);
    copy.id = newId(src.type);
    copy.x += dx;
    copy.y += dy;
    if (copy.groupId) {
      let g = groupRemap.get(copy.groupId);
      if (!g) { g = newId("group"); groupRemap.set(copy.groupId, g); }
      copy.groupId = g;
    }
    if (copy.type === "textBox") for (const b of copy.blocks) b.id = newId("block");
    s.elements.push(copy);
    idRemap.set(src.id, copy.id);
    out.push(copy.id);
  }
  for (const { beatIndex, track } of tracks) {
    const nt = idRemap.get(track.target);
    const beat = s.beats[beatIndex];
    if (nt && beat) beat.tracks.push({ ...structuredClone(track), id: newId("track"), target: nt });
  }
  return out;
}

/** Assign a fresh shared groupId to the given elements (≥2). Returns the group id. */
export function groupElements(deck: Deck, slideId: Id, ids: Id[]): Id | null {
  const s = slideById(deck, slideId);
  if (!s || ids.length < 2) return null;
  const g = newId("group");
  const set = new Set(ids);
  for (const el of s.elements) if (set.has(el.id)) el.groupId = g;
  return g;
}

/** Clear the groupId from the given elements (ungroup). */
export function ungroupElements(deck: Deck, slideId: Id, ids: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const set = new Set(ids);
  for (const el of s.elements) if (set.has(el.id)) delete el.groupId;
}

/** Elements paint in array order (last = top). Move the selection to the front. */
export function bringToFront(deck: Deck, slideId: Id, ids: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const set = new Set(ids);
  s.elements = [...s.elements.filter((e) => !set.has(e.id)), ...s.elements.filter((e) => set.has(e.id))];
}

/** Move the selection to the back (bottom of the paint order). */
export function sendToBack(deck: Deck, slideId: Id, ids: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const set = new Set(ids);
  s.elements = [...s.elements.filter((e) => set.has(e.id)), ...s.elements.filter((e) => !set.has(e.id))];
}

/** Raise the selection one step toward the front. */
export function raiseElements(deck: Deck, slideId: Id, ids: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const set = new Set(ids);
  for (let i = s.elements.length - 2; i >= 0; i--) {
    if (set.has(s.elements[i].id) && !set.has(s.elements[i + 1].id)) {
      [s.elements[i], s.elements[i + 1]] = [s.elements[i + 1], s.elements[i]];
    }
  }
}

/** Lower the selection one step toward the back. */
export function lowerElements(deck: Deck, slideId: Id, ids: Id[]): void {
  const s = slideById(deck, slideId);
  if (!s) return;
  const set = new Set(ids);
  for (let i = 1; i < s.elements.length; i++) {
    if (set.has(s.elements[i].id) && !set.has(s.elements[i - 1].id)) {
      [s.elements[i], s.elements[i - 1]] = [s.elements[i - 1], s.elements[i]];
    }
  }
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Align the given elements (≥2) to the selection's bounding-box edge/center. */
export function alignElements(deck: Deck, slideId: Id, ids: Id[], mode: AlignMode): void {
  const s = slideById(deck, slideId);
  if (!s || ids.length < 2) return;
  const set = new Set(ids);
  const els = s.elements.filter((e) => set.has(e.id));
  const minX = Math.min(...els.map((e) => e.x));
  const maxX = Math.max(...els.map((e) => e.x + e.width));
  const minY = Math.min(...els.map((e) => e.y));
  const maxY = Math.max(...els.map((e) => e.y + e.height));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const e of els) {
    if (mode === "left") e.x = minX;
    else if (mode === "right") e.x = maxX - e.width;
    else if (mode === "hcenter") e.x = cx - e.width / 2;
    else if (mode === "top") e.y = minY;
    else if (mode === "bottom") e.y = maxY - e.height;
    else if (mode === "vcenter") e.y = cy - e.height / 2;
  }
}

/** Evenly space the given elements (≥3) by gap along an axis (Figma-style). */
export function distributeElements(deck: Deck, slideId: Id, ids: Id[], axis: "h" | "v"): void {
  const s = slideById(deck, slideId);
  if (!s || ids.length < 3) return;
  const set = new Set(ids);
  const els = s.elements.filter((e) => set.has(e.id));
  if (axis === "h") {
    els.sort((a, b) => a.x - b.x);
    const span = els[els.length - 1].x + els[els.length - 1].width - els[0].x;
    const gap = (span - els.reduce((n, e) => n + e.width, 0)) / (els.length - 1);
    let x = els[0].x;
    for (const e of els) { e.x = x; x += e.width + gap; }
  } else {
    els.sort((a, b) => a.y - b.y);
    const span = els[els.length - 1].y + els[els.length - 1].height - els[0].y;
    const gap = (span - els.reduce((n, e) => n + e.height, 0)) / (els.length - 1);
    let y = els[0].y;
    for (const e of els) { e.y = y; y += e.height + gap; }
  }
}

/** Disable/enable every track on a slide that targets one plot part. Disabling
 *  (NOT deleting) is what makes the S/A/M tri-state non-destructive: a masked or
 *  shown-from-start part keeps its authored tracks (timing, stagger, easing) so
 *  flipping back to Animate restores them intact. Matches by part id at the
 *  granularity the track was authored (group or leaf). */
function setPartTracksDisabled(slide: Slide, elId: Id, part: string, disabled: boolean): void {
  for (const beat of slide.beats) {
    for (const t of beat.tracks) {
      if (t.target !== elId || t.part !== part) continue;
      if (disabled) t.disabled = true;
      else delete t.disabled;
    }
  }
}

/** The three resting states the X-ray GUI offers for a plot part (or part group):
 *   • "mask"    — hidden always (override hidden:true); its tracks are DISABLED.
 *   • "show"    — visible from beat 0 (clear hidden); tracks DISABLED (no anim).
 *   • "animate" — visible only once its build track plays (clear hidden, tracks
 *                 re-ENABLED; the caller/autobuild owns adding an enter track if
 *                 none exists).
 *  The override key may be a leaf id or a group id ("axis.x") — applyOverrides
 *  re-resolves groups to their leaves every render, so masks survive regen. */
export function setPartVisibility(deck: Deck, elId: Id, part: string, mode: "show" | "animate" | "mask"): void {
  const found = findElement(deck, elId);
  if (!found || found.el.type !== "plot") return;
  const el = found.el as SemanticPlotElement;
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

/** Merge a style patch into one plot part's override (the slide-mode X-ray
 *  cockpit's write path — stroke/fill/strokeWidth/opacity/fonts/hidden). A
 *  `null` value deletes that key; an override left empty is removed entirely.
 *  Keys may be leaf or group ids exactly like `setPartVisibility`. */
export function setPartStyle(
  deck: Deck,
  elId: Id,
  part: string,
  patch: Record<string, string | number | boolean | null | undefined>,
): void {
  const found = findElement(deck, elId);
  if (!found || found.el.type !== "plot") return;
  const el = found.el as SemanticPlotElement;
  const ov = (el.overrides = el.overrides ?? {});
  const cur = { ...(ov[part] ?? {}) } as Record<string, string | number | boolean>;
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) delete cur[k];
    else cur[k] = v;
  }
  if (Object.keys(cur).length === 0) delete ov[part];
  else ov[part] = cur;
  if (Object.keys(ov).length === 0) delete el.overrides;
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
  return addElement(deck, slideId, makeImagePanel(opts.assetId, opts) as Element);
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

/** Deep-copy a beat (fresh beat + track ids), inserted right after the original.
 *  Returns the new beat, or null. Beat 0 (the resting state) can't be duplicated. */
export function duplicateBeat(deck: Deck, slideId: Id, beatId: Id): Beat | null {
  const s = slideById(deck, slideId);
  if (!s) return null;
  const i = s.beats.findIndex((b) => b.id === beatId);
  if (i <= 0) return null;
  const copy = structuredClone(s.beats[i]);
  copy.id = newId("beat");
  if (copy.label) copy.label += " copy";
  for (const t of copy.tracks) t.id = newId("track");
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
 *  duration/stagger) travels untouched. */
export function moveTrackToBeat(deck: Deck, slideId: Id, trackId: Id, toBeatId: Id, at?: number): boolean {
  const s = slideById(deck, slideId);
  if (!s) return false;
  const to = beatById(s, toBeatId);
  if (!to) return false;
  for (const b of s.beats) {
    const i = b.tracks.findIndex((t) => t.id === trackId);
    if (i < 0) continue;
    const [t] = b.tracks.splice(i, 1);
    // Splicing out of the SAME beat shifts indices; recompute a safe insert point.
    const j = at != null ? Math.max(0, Math.min(at, to.tracks.length)) : to.tracks.length;
    to.tracks.splice(j, 0, t);
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
  opts: { duration?: number; easing?: import("./types").EasingToken; start?: number } = {},
): boolean {
  return setAnimation(deck, slideId, beatId, {
    id: newId("track"),
    target: plotElId,
    preset: "morph",
    to: { assetId: toAssetId },
    duration: opts.duration ?? 1200,
    easing: opts.easing ?? "smooth",
    ...(opts.start != null ? { start: opts.start } : {}),
  });
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
  // Every track carries a stable id; replacing a matched track keeps its id so
  // editor selection survives the edit, a brand-new track gets a fresh one.
  if (i >= 0) b.tracks[i] = { ...track, id: track.id ?? b.tracks[i].id ?? newId("track") };
  else b.tracks.push({ ...track, id: track.id ?? newId("track") });
  return true;
}

/** Backfill stable ids onto any track that lacks one (decks authored before
 *  `Track.id` existed). Idempotent; called at load so the editor can key/select
 *  tracks reliably. Mutates in place + returns the deck. */
export function ensureTrackIds(deck: Deck): Deck {
  for (const s of deck.slides) for (const b of s.beats) for (const t of b.tracks) if (!t.id) t.id = newId("track");
  return deck;
}

/** Bring a loaded deck up to the current element model (mirrors src/lib/
 *  migrate.ts — decks are separate JSON, not covered by migrateProject).
 *  `type:"svg"` elements (deleted from the union, figure-v1 P4) become
 *  semantic plots: same id/geometry, `overrides:{}`, `source.svgPath`
 *  best-effort from the deck-local asset entry (PROJECT-relative, so
 *  loadDeckAssets/gatherDeckPayload can read it) — no manifestPath (sidecar
 *  presence is the fluxplot/vanilla discriminator; the manifest derives at
 *  cachePlot). Idempotent; called at every deck-load seam (GUI loadDeckModel,
 *  flux-core loadDeck). Mutates in place + returns the deck. */
export function migrateDeck(deck: Deck): Deck {
  for (const s of deck.slides ?? []) {
    for (const e of s.elements ?? []) {
      if ((e as { type: string }).type !== "svg") continue;
      const el = e as unknown as SemanticPlotElement;
      (el as { type: string }).type = "plot";
      if (!el.overrides) el.overrides = {};
      if (!el.source) {
        const a = (deck.assets ?? []).find((x) => x.id === el.assetId);
        el.source = { svgPath: a?.path ? `slides/${deck.id}/${a.path}` : "" };
      }
    }
  }
  return deck;
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
