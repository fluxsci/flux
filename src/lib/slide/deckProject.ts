// ---------------------------------------------------------------------------
// Flux Slide — the deck ⇄ figure-Project projection (the heart of the
// slides-are-figures reuse), plus the shared clone-with-fresh-ids core behind
// Send-to-deck / Send-to-canvas / the add_slide_figure verb.
//
// PURE by contract: no Svelte, no DOM, no Node — flux-core loads this module.
//
// The model: the Slide module feeds a deck INTO the figure editor by
// projecting every slide as a Figure on one synthetic canvas ("deck"). The
// figure editor then edits `project.figures[active].elements` exactly as it
// edits any figure; the presentation overlay (beats/transition/notes/camera/
// order/stage/theme) stays OUTSIDE the projection, and `projectIntoDeck`
// recombines both halves for disk. Elements therefore live once (in the
// project), the overlay lives once (in the slide store / prev deck), and
// `projectIntoDeck(deckToProject(d), d)` is the identity (round-trip gated by
// scripts/verify-deckproject-roundtrip.ts).
// ---------------------------------------------------------------------------

import type { Asset, Element, GroupDef, Id, Project } from "../types";
import type { Deck, Slide, StageSize } from "./types";
import { cloneGroupsFor } from "../groups";
import { nodesToPath, pathToNodes } from "../path";
import { resolveTheme } from "./theme";
import { newId } from "../ids";

/** The synthetic canvas id every projected slide-figure lives on. */
export const DECK_CANVAS_ID = "deck";

/** The background a slide RESTS at when it sets none of its own: the deck's
 *  default, else the theme's. The projection seeds this into
 *  `Figure.background` (so the canvas paints it live) and the fold-back
 *  compares against it (so inherited defaults are never materialized onto
 *  every slide). */
export function slideDefaultBackground(deck: Pick<Deck, "background" | "theme">): string {
  return deck.background ?? resolveTheme(deck.theme).background;
}

/** Project a deck's static content into a figure Project for the figure editor
 *  to edit. Each slide → one Figure on the synthetic "deck" canvas, all frames
 *  coincident at (0,0) so the global viewport carries pan/zoom across slide
 *  switches. Presentation (beats/transition/notes/camera) is NOT included — it
 *  stays in the slide store. Background IS included (Figure.background renders
 *  live); projectIntoDeck folds it back.
 *
 *  `resolvedAssets` = deck.assets plus any project-resolved assets (plots /
 *  figure-derived content referenced by id — see slideBridge). */
export function deckToProject(deck: Deck, resolvedAssets: Asset[]): Project {
  const defaultBg = slideDefaultBackground(deck);
  return {
    version: 2,
    name: deck.title,
    canvases: [{ id: DECK_CANVAS_ID, name: deck.title }],
    figures: deck.slides.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      canvasId: DECK_CANVAS_ID,
      x: 0,
      y: 0,
      width: deck.stage.width,
      height: deck.stage.height,
      background: s.background ?? defaultBg,
      elements: structuredClone(s.elements),
      ...(s.groups ? { groups: structuredClone(s.groups) } : {}),
      ...(s.guides ? { guides: structuredClone(s.guides) } : {}),
    })),
    assets: structuredClone(resolvedAssets),
    palette: deck.palette ? [...deck.palette] : [],
    colorGroups: deck.colorGroups ? structuredClone(deck.colorGroups) : [],
    ...(deck.textStyles !== undefined ? { textStyles: structuredClone(deck.textStyles) } : {}),
  };
}

/** Fold the figure editor's live Project back into the deck's static content,
 *  preserving every presentation field (beats/transition/notes/camera/layout)
 *  from `prev`. Order follows the PREV deck's slide order (the figure list
 *  order is cosmetic; the deck's order is truth); a figure with no prev slide
 *  (defensive — slide creation goes through the deck ops) is appended with a
 *  fresh resting beat, and a prev slide whose figure is gone is dropped.
 *
 *  Background fold-back: figure.background becomes slide.background UNLESS it
 *  equals the deck/theme default the projection seeded (don't materialize
 *  inherited defaults onto every slide).
 *
 *  `externalAssetIds` = assets resolved FROM the project at load (plots,
 *  fig/-owned media) — they are never folded into deck.assets (the deck
 *  references them by id; it does not own their bytes). */
export function projectIntoDeck(
  project: Project,
  prev: Deck,
  opts: { externalAssetIds?: ReadonlySet<string> } = {},
): Deck {
  const external = opts.externalAssetIds;
  const defaultBg = slideDefaultBackground(prev);
  const figById = new Map(project.figures.map((f) => [f.id, f] as const));

  const slides: Slide[] = [];
  const used = new Set<Id>();
  for (const ps of prev.slides) {
    const fig = figById.get(ps.id);
    if (!fig) continue; // slide's figure deleted → the slide goes with it
    used.add(ps.id);
    slides.push(foldSlide(fig, ps, defaultBg));
  }
  // Defensive: figures on the deck canvas with no prev slide entry become new
  // slides (fresh resting beat) so no content can silently vanish on save.
  for (const fig of project.figures) {
    if (used.has(fig.id) || fig.canvasId !== DECK_CANVAS_ID) continue;
    slides.push(
      foldSlide(fig, { id: fig.id, elements: [], beats: [{ id: newId("beat"), label: "base", tracks: [] }] }, defaultBg),
    );
  }

  return {
    schemaVersion: prev.schemaVersion,
    id: prev.id,
    title: project.name || prev.title,
    created: prev.created,
    modified: prev.modified,
    stage: { ...prev.stage },
    theme: prev.theme,
    defaults: structuredClone(prev.defaults),
    ...(prev.background !== undefined ? { background: prev.background } : {}),
    palette: [...(project.palette ?? [])],
    ...(project.colorGroups !== undefined ? { colorGroups: structuredClone(project.colorGroups) } : {}),
    ...(project.textStyles !== undefined ? { textStyles: structuredClone(project.textStyles) } : {}),
    assets: structuredClone(project.assets.filter((a) => !external?.has(a.id))),
    slides,
  };
}

function foldSlide(fig: Project["figures"][number], prev: Slide, defaultBg: string): Slide {
  const name = fig.name === fig.id ? prev.name : fig.name;
  return {
    id: prev.id,
    ...(name !== undefined ? { name } : {}),
    ...(prev.layout !== undefined ? { layout: prev.layout } : {}),
    elements: structuredClone(fig.elements),
    ...(fig.groups && Object.keys(fig.groups).length ? { groups: structuredClone(fig.groups) } : {}),
    ...(fig.guides ? { guides: structuredClone(fig.guides) } : {}),
    ...(fig.background !== defaultBg ? { background: fig.background } : {}),
    ...(prev.transition !== undefined ? { transition: prev.transition } : {}),
    ...(prev.notes !== undefined ? { notes: prev.notes } : {}),
    ...(prev.camera !== undefined ? { camera: structuredClone(prev.camera) } : {}),
    beats: structuredClone(prev.beats),
  };
}

// ---------------------------------------------------------------------------
// The ONE clone-with-fresh-ids core (Send to deck / Send to canvas /
// add_slide_figure). Deep-clones a set of elements + their group registry with
// fresh element AND group ids (names/nesting/state preserved via the same
// cloneGroupsFor the figure editor's paste uses).
// ---------------------------------------------------------------------------

export interface ClonedContent {
  elements: Element[];
  groups: Record<Id, GroupDef>;
  /** original element id → its clone's id (callers retarget beats/refs). */
  idRemap: Map<Id, Id>;
}

export function cloneContentWithFreshIds(
  elements: readonly Element[],
  groups: Record<Id, GroupDef> | undefined,
): ClonedContent {
  const groupRemap = new Map<Id, Id>();
  const cloned = cloneGroupsFor(groups, elements as Element[], groupRemap);
  const idRemap = new Map<Id, Id>();
  const out = structuredClone(elements as Element[]).map((el) => {
    const nid = newId(el.type);
    idRemap.set(el.id, nid);
    el.id = nid;
    if (el.groupId) el.groupId = groupRemap.get(el.groupId) ?? el.groupId;
    return el;
  });
  return { elements: out, groups: cloned, idRemap };
}

/** Place cloned content onto a stage at NATIVE size (same 96/in ruler → 1:1,
 *  no rescaling), centered. Fit-to-frame is applied ONLY if the content's
 *  bounding box exceeds the frame (e.g. a portrait 680×850 figure onto a
 *  640×360 slide) — scaling geometry, strokes, and font sizes uniformly so
 *  the shrunken copy keeps its internal proportions. */
export function placeContentOnStage(elements: Element[], stage: StageSize): void {
  if (!elements.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of elements) {
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x + e.width);
    y1 = Math.max(y1, e.y + e.height);
  }
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const s = Math.min(1, stage.width / w, stage.height / h);
  const ox = (stage.width - w * s) / 2;
  const oy = (stage.height - h * s) / 2;
  for (const e of elements) {
    e.x = ox + (e.x - x0) * s;
    e.y = oy + (e.y - y0) * s;
    if (s !== 1) scaleElementInPlace(e, s);
  }
}

/** Uniformly scale one element's own geometry/typography by `s` (position is
 *  handled by the caller). Mirrors ops.scaleElements' per-type treatment. */
function scaleElementInPlace(e: Element, s: number): void {
  e.width *= s;
  e.height *= s;
  if (e.type === "text") {
    e.fontSize *= s;
    delete e.lines; // wrap cache is metric-derived; GUI reflows, headless falls back
  } else if (e.type === "line") {
    e.x1 *= s; e.y1 *= s; e.x2 *= s; e.y2 *= s;
    e.strokeWidth *= s;
  } else if (e.type === "rect") {
    e.strokeWidth *= s;
    e.cornerRadius *= s;
  } else if (e.type === "ellipse") {
    e.strokeWidth *= s;
  } else if (e.type === "path") {
    // nodes are the authoritative geometry (element-local); d regenerates via
    // the shared emitter (path.ts). A legacy d-only path is adopted into nodes
    // first (same as ops.updatePath) so its geometry scales too.
    if (!e.nodes) e.nodes = pathToNodes(e.d);
    for (const n of e.nodes) {
      n.x *= s; n.y *= s;
      if (n.hIn) { n.hIn.dx *= s; n.hIn.dy *= s; }
      if (n.hOut) { n.hOut.dx *= s; n.hOut.dy *= s; }
    }
    e.d = nodesToPath(e.nodes, e.closed);
    e.strokeWidth *= s;
  } else if (e.type === "plot") {
    // pt-true compensation handles the box change; contentScale keeps glyphs
    // proportioned to the shrunken box.
    e.contentScale = (e.contentScale ?? 1) * s;
  }
}
