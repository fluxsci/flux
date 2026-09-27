import { updateManifest } from "./manifest";
// flux-core/slides.ts — the Flux Slide deck format as a Node library (CLI + MCP).
//
// Mirrors the figure side of flux-core/index.ts: load/save a deck through the
// shared pure ops core (src/lib/slide/ops.ts), hold an advisory lock so an agent
// write defers rather than clobbering a live human edit, and journal every
// mutation. "The file is the API" — the GUI (slideBridge.ts) and this module
// read/write the same slides/<id>/deck.json.
//
// Slides-are-figures: a slide's elements are the figure `Element` union, so
// the static-content verbs delegate to the SAME figure constructors/ops the
// figure verbs use (twin-engine: one core, no drift). `add_slide_figure` is a
// COPY (fresh-id clone of a paper figure's elements+groups onto the slide, at
// native size on the shared 96/in ruler) — the headless twin of the GUI's
// "Send to deck", both through slideOps.addFigureContentToSlide.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import Ajv from "ajv";
import { safeJoin, journal, loadManifest, getClient, ensureDom } from "./index";
import { externalDeckAssetMetadata as sharedExternalDeckAssetMetadata } from "../src/lib/slide/embedSources";
const externalDeckAssetMetadata = (root: string, deck: Deck) => sharedExternalDeckAssetMetadata(root, deck, { exists, readText: p => fs.readFile(p, "utf8") });
import { readProjectDependencies, slideRemovalBlocker } from "../src/lib/project/dependencies";
import { prepareVideo, cleanupPrepared } from "./videoMedia";
import { atomicWrite } from "./fsx";
import { withLock, assertLockOwned } from "./locks";
import { commitDeckGeneration } from "../src/lib/project/deckGeneration";
import { recoverTextGeneration, type GenerationWrite, type TextGenerationIO } from "../src/lib/project/textGeneration";
import { exportRecoveryIO, confinedRecoveryPath } from "./recovery";
import { SCHEMAS } from "./schemas";
import { preparePlot, buildPartIndex } from "../src/lib/plot/parse";
import * as slideOps from "../src/lib/slide/ops";
import type { TrackCascadeSpec } from "../src/lib/cascade";
import { loadFigModel } from "./model";
import { syncFigureAssets } from "./figures";
import { planSourceUpdates, writeSourceUpdates, hasCompleteSvgStructure } from "../src/lib/plot/sourceSync";
import { svgIntrinsicSize } from "../src/lib/plot/svgGeometry";
import { deckSourceProject, applyDeckSourceUpdates, reconcileDeckExternalAssetSizes } from "../src/lib/slide/sourceSync";
import { plotSourceCandidates } from "../src/lib/plot/source";
import { animateElement, animatePart, listMorphCandidates } from "../src/lib/slide/autobuild";
import { slideAssetIds } from "../src/lib/slide/deckProject";
import { gatherPayload } from "../src/lib/slide/payload";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { ExportPayload } from "../src/lib/slide/export/runtime";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Deck, Track } from "../src/lib/slide/types";
import { DECK_SCHEMA_VERSION } from "../src/lib/slide/types";
import type { ProjectManifest } from "../src/lib/project/types";
import { isNewerSchema, newerSchemaMessage } from "../src/lib/project/types";
import type { Box, TextOpts } from "../src/lib/ops";
import type { Asset } from "../src/lib/types";

// POSIX, not the platform: these are PROJECT-RELATIVE paths, and one of them
// (the derived `svgPath`) is PERSISTED into deck.json. `path.join` on Windows
// wrote `fig\assets\x.svg`, which no other platform resolves — a deck authored
// on Windows would have arrived broken (2026-09-22). Node accepts forward
// slashes on Windows for the filesystem side, so one form serves both.
const j = (...p: string[]) => path.posix.join(...p);
const stamp = () => new Date().toISOString();

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function readJSON<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
async function writeText(p: string, t: string): Promise<void> {
  await atomicWrite(p, t); // W2: durable tmp+fsync+rename
}

const deckReadEvidence = new WeakMap<Deck, {path:string;text:string}>();
function deckGenerationIO(root: string): TextGenerationIO {
  const io = exportRecoveryIO(root), abs = (rel: string) => safeJoin(root, rel);
  return { validatePath:rel=>io.validatePath!(abs(rel)), read: rel=>io.readText(abs(rel)), write:(rel,text)=>io.writeText(abs(rel),text), remove:rel=>io.removeFile(abs(rel)), fsyncDir:rel=>io.fsyncDir!(abs(rel)),
    readBytes: async rel=>{const file=abs(rel);await confinedRecoveryPath(root,file);try{return await fs.readFile(file)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}},
    writeBytes: async(rel,bytes)=>{const file=abs(rel);await confinedRecoveryPath(root,file);await atomicWrite(file,bytes)},
  };
}
async function withDeckMutation<T>(root: string, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  return withLock(root,"project",getClient(),projectLease=>withLock(root,"slides",getClient(),async slideLease=>{
    const assertOwned = async()=>{await assertLockOwned(projectLease);await assertLockOwned(slideLease)};
    await withLock(root,"manifest",getClient(),async manifestLease=>{await recoverTextGeneration(deckGenerationIO(root),async()=>{await assertOwned();await assertLockOwned(manifestLease)})});
    return fn(assertOwned);
  }));
}
const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

/** Resolve a deck's on-disk path: prefer its manifest entry, else the default. */
async function resolveDeckPath(root: string, deckId: string): Promise<string> {
  const m = await loadManifest(root).catch(() => null);
  const entry = (m?.slides ?? []).find((s) => s.id === deckId);
  return safeJoin(root, entry?.path ?? deckRel(deckId));
}

// --------------------------------------------------------------------------
// list / load / save
// --------------------------------------------------------------------------
export interface DeckSummary {
  id: string;
  path: string;
  title: string;
  slides: number;
  order?: number;
}

/** listDecks: the project's decks (from project.json.slides[]), enriched with
 *  each deck's title + slide count (best-effort). */
export async function listDecks(root: string): Promise<DeckSummary[]> {
  const m = await loadManifest(root).catch(() => null);
  const entries = m?.slides ?? [];
  const out: DeckSummary[] = [];
  for (const e of entries) {
    const p = safeJoin(root, e.path ?? deckRel(e.id));
    let title = (e as { title?: string }).title ?? e.id;
    let slides = 0;
    try {
      const deck = await readJSON<Deck>(p);
      title = deck.title ?? title;
      slides = deck.slides?.length ?? 0;
    } catch {
      /* unreadable / missing deck.json — still list the entry */
    }
    out.push({ id: e.id, path: e.path ?? deckRel(e.id), title, slides, order: (e as { order?: number }).order });
  }
  return out;
}

/** loadDeck: read slides/<deckId>/deck.json. Forward-version guard first;
 *  then normalizeDeck migrates (0.2–0.4 → 0.5 stamp) + backfills track ids.
 *  A pre-0.2.0 deck remains the sanctioned clean break — no migration (it
 *  fails schema validation via validate_deck; here it loads as-is and the
 *  first structural miss surfaces at op time — the GUI additionally
 *  quarantines). */
export async function loadDeck(root: string, deckId: string): Promise<Deck> {
  const p = await resolveDeckPath(root, deckId);
  if (!(await exists(p))) throw new Error(`deck not found: ${deckId} (${path.relative(root, p)})`);
  const text = await fs.readFile(p,"utf8"), raw = JSON.parse(text) as Deck;
  if (isNewerSchema(raw.schemaVersion, DECK_SCHEMA_VERSION))
    throw new Error(newerSchemaMessage(path.relative(root, p), raw.schemaVersion, DECK_SCHEMA_VERSION));
  const normalized = slideOps.normalizeDeck(raw);
  deckReadEvidence.set(normalized,{path:path.relative(root,p).split(path.sep).join("/"),text});
  return normalized;
}

/** saveDeck: write deck.json (restamp modified) + register in the manifest, under
 *  the "slides" advisory lock, then journal. */
export async function saveDeck(root: string, deck: Deck, action = "save_deck"): Promise<void> {
  await withDeckMutation(root, owned => saveDeckUnlocked(root, deck, owned));
  await journal(root, { action, deck: deck.id, slides: deck.slides.length });
}
async function saveDeckUnlocked(root: string, deck: Deck, assertOwned: () => Promise<void>, writes: ReadonlyMap<string, GenerationWrite> = new Map()): Promise<void> {
  reconcileDeckExternalAssetSizes(deck, await externalDeckAssetMetadata(root, deck));
  const evidence = deckReadEvidence.get(deck);
  const result = await withLock(root,"manifest",getClient(),manifestLease=>commitDeckGeneration(deckGenerationIO(root), deck, {
    writes, ...(evidence?{expectedPath:evidence.path,expectedText:evidence.text}:{}),
    assertOwned:async()=>{await assertOwned();await assertLockOwned(manifestLease)},
  }));
  Object.assign(deck,result.deck);deckReadEvidence.set(deck,{path:result.path,text:result.text});
}

/** W3: run a deck read→mutate→write atomically under the "slides" lock (the load
 *  happens INSIDE the lock, so two agents can't interleave a lost update). */
export async function mutateDeck<T>(
  root: string,
  deckId: string,
  action: string,
  fn: (deck: Deck) => T | Promise<T>,
): Promise<T> {
  let out!: T;
  let slideCount = 0;
  await withDeckMutation(root, async owned => {
    const deck = await loadDeck(root, deckId);
    reconcileDeckExternalAssetSizes(deck, await externalDeckAssetMetadata(root, deck));
    out = await fn(deck);
    slideCount = deck.slides.length;
    await saveDeckUnlocked(root, deck, owned);
  });
  await journal(root, { action, deck: deckId, slides: slideCount });
  return out;
}

// --------------------------------------------------------------------------
// verbs (thin wrappers over the pure ops, mirroring index.ts's figure verbs)
// --------------------------------------------------------------------------

/** new-deck: scaffold a fresh deck on disk + register it. */
export async function createDeck(
  root: string,
  opts: { id?: string; title?: string; theme?: string } = {},
): Promise<{ deckId: string; path: string }> {
  const deck = slideOps.createDeck({ id: opts.id, title: opts.title, theme: opts.theme });
  await saveDeck(root, deck, "create_deck");
  return { deckId: deck.id, path: deckRel(deck.id) };
}

/** add-slide: append a slide to a deck (layout starters seed figure `text`
 *  elements at figure-ruler sizes). */
export async function addSlide(
  root: string,
  deckId: string,
  opts: { name?: string; layout?: import("../src/lib/slide/types").LayoutId } = {},
): Promise<{ slideId: string }> {
  return mutateDeck(root, deckId, "add_slide", (deck) => {
    const slide = slideOps.addSlide(deck, { ...opts, starters: true });
    return { slideId: slide.id };
  });
}

const mustSlide = (deck: Deck, slideId: string) => {
  const s = slideOps.slideById(deck, slideId);
  if (!s) throw new Error(`slide not found: ${slideId}`);
  return s;
};

/** delete-slide: remove a slide. Returns the id the GUI would activate next. */
export async function deleteSlide(root: string, deckId: string, slideId: string, opts: { force?: boolean } = {}): Promise<{ nextActiveId: string | null }> {
  if (!opts.force) {
    const deps = await readProjectDependencies(root, { readText: p => fs.readFile(p, "utf8"), exists,
      readdir: async p => (await fs.readdir(p, { withFileTypes: true })).map(e => ({ name: e.name, dir: e.isDirectory() })) });
    const blocker = slideRemovalBlocker(deps, deckId, slideId);
    if (blocker) throw new Error(`${blocker} Pass --force to delete anyway.`);
  }
  return mutateDeck(root, deckId, "delete_slide", (deck) => {
    mustSlide(deck, slideId);
    return slideOps.deleteSlide(deck, slideId);
  });
}

/** duplicate-slide: deep-copy a slide (fresh element/group/beat/track ids). */
export async function duplicateSlide(root: string, deckId: string, slideId: string): Promise<{ slideId: string }> {
  return mutateDeck(root, deckId, "duplicate_slide", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.duplicateSlide(deck, slideId);
    if (!id) throw new Error(`could not duplicate slide ${slideId}`);
    return { slideId: id };
  });
}

/** reorder-slides: set the slide order to exactly `order` (must be a permutation). */
export async function reorderSlides(root: string, deckId: string, order: string[]): Promise<void> {
  await mutateDeck(root, deckId, "reorder_slides", (deck) => {
    slideOps.reorderSlides(deck, order);
  });
}

/** set-slide: patch a slide's name/layout/background/transition/notes/camera. */
export async function setSlide(root: string, deckId: string, slideId: string, patch: slideOps.SetSlidePatch): Promise<void> {
  await mutateDeck(root, deckId, "set_slide", (deck) => {
    mustSlide(deck, slideId);
    slideOps.setSlide(deck, slideId, patch);
  });
}

/** set-theme: switch the deck theme (flux-dark|light|paper|midnight|slate|sepia|contrast). */
export async function setDeckTheme(root: string, deckId: string, theme: string): Promise<void> {
  await mutateDeck(root, deckId, "set_theme", (deck) => {
    slideOps.setTheme(deck, theme);
  });
}

/** add-text: add a figure `text` element to a slide (the SAME constructor +
 *  headless layout convention add_fig_text uses). Returns the new element id. */
export async function addTextToSlide(
  root: string,
  deckId: string,
  slideId: string,
  opts: { text: string } & Box & TextOpts,
): Promise<{ elementId: string }> {
  return mutateDeck(root, deckId, "add_text", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.addSlideText(deck, slideId, opts);
    if (!id) throw new Error(`could not add text to ${slideId}`);
    return { elementId: id };
  });
}

/** Native preparation runs outside the deck lock; publication is one atomic
 * shared-model mutation. Source files remain untouched. */
export async function addVideoToSlide(root: string, deckId: string, slideId: string, opts: {
  sourcePath: string; x?: number; y?: number; width?: number; height?: number;
  muted?: boolean; loop?: boolean; signal?: AbortSignal;
  onProgress?: (value: { phase: string; percent: number }) => void;
}): Promise<{ elementId: string; assetId: string }> {
  mustSlide(await loadDeck(root, deckId), slideId);
  const prepared = await prepareVideo({ root, deckId, sourcePath: opts.sourcePath, signal: opts.signal, onProgress: opts.onProgress });
  try {
    if (opts.signal?.aborted) throw new Error("Video import cancelled");
    return await mutateDeck(root, deckId, "add_slide_video", deck => {
      mustSlide(deck, slideId);
      deck.assets.push(prepared.asset, prepared.posterAsset);
      const elementId = slideOps.addVideoToSlide(deck, slideId, {
        assetId: prepared.asset.id, posterAssetId: prepared.posterAsset.id,
        durationMs: prepared.asset.durationMs!,
        x: opts.x, y: opts.y, width: opts.width, height: opts.height, muted: opts.muted, loop: opts.loop,
      });
      if (!elementId) throw new Error("Unable to place the prepared video clip");
      return { elementId, assetId: prepared.asset.id };
    });
  } catch (error) {
    // A post-publication journal failure must never delete a referenced clip.
    const live = await loadDeck(root, deckId).catch(() => null);
    if (live && !live.assets.some(a => a.id === prepared.asset.id)) await cleanupPrepared(root, deckId, prepared);
    throw error;
  }
}

export async function setVideoTrack(root: string, deckId: string, slideId: string, beatId: string,
  target: string, action: "start" | "pause" | "stop", opts: { start?: number } = {}): Promise<void> {
  await mutateDeck(root, deckId, "set_video_track", deck => {
    if (!slideOps.setVideoTrack(deck, slideId, beatId, target, action, opts)) throw new Error("Video target, step, or command timing is invalid");
  });
}

export async function setVideoSettings(root: string, deckId: string, slideId: string, target: string,
  opts: { muted?: boolean; loop?: boolean }): Promise<void> {
  await mutateDeck(root, deckId, "set_video_settings", deck => {
    if (!slideOps.setVideoSettings(deck, slideId, target, opts)) throw new Error("Video clip not found on this slide");
  });
}

/** add-figure: COPY a project figure's elements + groups onto a slide (fresh
 *  ids, native size — the shared 96/in ruler — fit only if it exceeds the
 *  stage). Plot parts stay addressable for animate_part. The headless twin of
 *  the GUI's "Send to deck". Returns the new element ids. */
export async function addFigureToSlide(
  root: string,
  deckId: string,
  slideId: string,
  figureId: string,
  opts: { x?: number; y?: number } = {},
): Promise<{ elementIds: string[] }> {
  const { project } = await loadFigModel(root);
  const figure = project.figures.find((f) => f.id === figureId);
  if (!figure) throw new Error(`figure not found: ${figureId}`);
  return mutateDeck(root, deckId, "add_slide_figure", (deck) => {
    mustSlide(deck, slideId);
    const ids = slideOps.addFigureContentToSlide(deck, slideId, figure, opts);
    if (!ids.length) throw new Error(`figure ${figureId} has no elements to copy`);
    return { elementIds: ids };
  });
}

/** add-beat: append a build beat (a step of the slide's on-click timeline). */
export async function addBeat(
  root: string,
  deckId: string,
  slideId: string,
  opts: slideOps.AddBeatOpts = {},
): Promise<{ beatId: string }> {
  return mutateDeck(root, deckId, "add_beat", (deck) => {
    mustSlide(deck, slideId);
    const beat = slideOps.addBeat(deck, slideId, opts);
    if (!beat) throw new Error(`could not add beat to ${slideId}`);
    return { beatId: beat.id };
  });
}

/** set-animation: add (or replace) an animation track on a beat — the general
 *  mechanism behind every preset (fade/drawOn/stagger/move/morph/camera/…). */
export async function setAnimation(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  track: Track,
  opts: { append?: boolean } = {},
): Promise<void> {
  await mutateDeck(root, deckId, "set_animation", (deck) => {
    mustSlide(deck, slideId);
    const ok = opts.append ? slideOps.appendAnimation(deck, slideId, beatId, track) : slideOps.setAnimation(deck, slideId, beatId, track);
    if (!ok) throw new Error(`beat not found: ${beatId} on ${slideId}`);
  });
}

/** Create independent ghost results through the same pure operation as the UI. */
export async function addGhostTransform(
  root: string, deckId: string, slideId: string, beatId: string, sourceId: string,
  opts: Parameters<typeof slideOps.addGhostTransform>[4] = {},
): Promise<NonNullable<ReturnType<typeof slideOps.addGhostTransform>>> {
  return mutateDeck(root, deckId, "ghost_transform", (deck) => {
    mustSlide(deck, slideId);
    const result = slideOps.addGhostTransform(deck, slideId, beatId, sourceId, opts);
    if (!result) throw new Error(`Ghost transform needs an existing source and a build step: ${sourceId} on ${beatId}`);
    return result;
  });
}

/** set-transform: add or update THE transform track for a target on a beat
 *  (max one per target per beat — the family law). The ergonomic form: agents
 *  pass a sparse element-state patch instead of hand-building diffs. */
export async function setTransformTrack(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  targetId: string,
  opts: {
    state?: Record<string, unknown>;
    replaceState?: boolean;
    start?: number;
    duration?: number;
    easing?: import("../src/lib/slide/types").EasingToken;
    toAssetId?: string;
  } = {},
): Promise<{ trackId: string }> {
  return mutateDeck(root, deckId, "set_transform", async (deck) => {
    mustSlide(deck, slideId);
    // a content target needs explicit paths (resolvers must not guess)
    const paths = opts.toAssetId ? await resolveAssetSource(root, opts.toAssetId) : {};
    const t = slideOps.setTransform(deck, slideId, beatId, targetId, {
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.replaceState ? { replaceState: true } : {}),
      ...(opts.start != null ? { start: opts.start } : {}),
      ...(opts.duration != null ? { duration: opts.duration } : {}),
      ...(opts.easing != null ? { easing: opts.easing } : {}),
      ...(opts.toAssetId != null ? { toAssetId: opts.toAssetId } : {}),
      ...paths,
    });
    if (!t?.id) throw new Error(`beat not found: ${beatId} on ${slideId}`);
    return { trackId: t.id };
  });
}

/** group-tracks: bundle tracks on one beat under a labeled, collapsible
 *  TrackGroup (a presentational animator lane group). */
export async function groupTracksVerb(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  trackIds: string[],
  label?: string,
): Promise<{ groupId: string }> {
  return mutateDeck(root, deckId, "group_tracks", (deck) => {
    mustSlide(deck, slideId);
    const gid = slideOps.groupTracks(deck, slideId, beatId, trackIds, label);
    if (!gid) throw new Error(`no matching tracks on beat ${beatId}`);
    return { groupId: gid };
  });
}

/** ungroup-tracks: dissolve the groups the given tracks belong to. */
export async function ungroupTracksVerb(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  trackIds: string[],
): Promise<void> {
  await mutateDeck(root, deckId, "ungroup_tracks", (deck) => {
    mustSlide(deck, slideId);
    slideOps.ungroupTracks(deck, slideId, beatId, trackIds);
  });
}

/** cascade-tracks: apply a stepped delta across tracks' timing — the track at
 *  rank k gets value ⊕ delta·step_k (step = k with firstFixed, else k+1), in
 *  timeline (beat, then lane) or list (given) order. Same pure core the GUI
 *  popover runs (slideOps.cascadeTracks). */
export async function cascadeTracksVerb(
  root: string,
  deckId: string,
  slideId: string,
  trackIds: string[],
  spec: TrackCascadeSpec,
): Promise<{ changed: number }> {
  return mutateDeck(root, deckId, "cascade_tracks", (deck) => {
    mustSlide(deck, slideId);
    const changed = slideOps.cascadeTracks(deck, slideId, trackIds, spec);
    if (!changed) throw new Error(`no matching tracks on ${slideId}`);
    return { changed };
  });
}

/** apply-anim-template: run the SAME pure matching engine the GUI library
 *  uses (animTemplates.applyTemplate) against a machine-library template (by
 *  name) or an explicit .json path, binding onto a part container
 *  (elementId+part) or an element set. Bound tracks land on the beat as one
 *  labeled TrackGroup; partial matches are returned, never invented. */
export async function applyAnimTemplateVerb(
  root: string,
  deckId: string,
  slideId: string,
  opts: {
    template: string; // library name (matched case-insensitively) or a path to a .json
    beatId?: string;
    elementIds?: string[];
    elementId?: string;
    part?: string;
  },
): Promise<{ matched: number; total: number; trackIds: string[]; groupId?: string; unmatched: string[] }> {
  const { parseAnimTemplate, applyTemplate } = await import("../src/lib/slide/animTemplates");
  const { resolveFluxConfigPath } = await import("./fluxlib");
  // resolve the template: explicit path first, else the machine library by name
  let tpl: import("../src/lib/slide/animTemplates").AnimTemplate | null = null;
  try {
    tpl = parseAnimTemplate(JSON.parse(await fs.readFile(path.resolve(root, opts.template), "utf8")));
  } catch {
    /* not a readable path — try the library */
  }
  if (!tpl) {
    const dir = path.join(await resolveFluxConfigPath(), "presets", "anim-templates");
    let entries: string[] = [];
    try { entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")); } catch { /* no library yet */ }
    for (const f of entries) {
      try {
        const cand = parseAnimTemplate(JSON.parse(await fs.readFile(path.join(dir, f), "utf8")));
        if (cand && (cand.name.toLowerCase() === opts.template.toLowerCase() || f === opts.template)) {
          tpl = cand;
          break;
        }
      } catch { /* skip unreadable */ }
    }
  }
  if (!tpl) throw new Error(`template not found: ${opts.template} (not a readable file, and no library template by that name)`);
  const theTpl = tpl;

  return mutateDeck(root, deckId, "apply_anim_template", async (deck) => {
    const s = mustSlide(deck, slideId);
    const beat =
      (opts.beatId ? s.beats.find((b) => b.id === opts.beatId) : undefined) ??
      (s.beats.length > 1 ? s.beats[s.beats.length - 1] : slideOps.addBeat(deck, slideId, { label: "Beat 1", advance: "click" })!);
    const scope =
      opts.elementId != null
        ? ({ kind: "part-container", elementId: opts.elementId, partId: opts.part ?? "" } as const)
        : ({ kind: "elements", ids: opts.elementIds ?? [] } as const);
    if (scope.kind === "elements" && !scope.ids.length) throw new Error("pass elementIds (a set) or elementId [+ part] (a container scope)");
    const manifests = new Map<string, FluxPlotManifest | undefined>();
    for (const el of s.elements) {
      if (el.type === "plot") manifests.set(el.id, await readPlotManifest(root, el));
    }
    const res = applyTemplate(theTpl, scope as import("../src/lib/slide/animTemplates").TemplateScope, {
      elements: s.elements,
      manifestFor: (id) => manifests.get(id),
    });
    const trackIds: string[] = [];
    for (const t of res.tracks) {
      slideOps.setAnimation(deck, slideId, beat.id, t);
      if (t.id) trackIds.push(t.id);
    }
    let groupId: string | undefined;
    if (trackIds.length) groupId = slideOps.groupTracks(deck, slideId, beat.id, trackIds, theTpl.name) ?? undefined;
    return { matched: res.matched, total: res.total, trackIds, ...(groupId ? { groupId } : {}), unmatched: res.unmatched };
  });
}

/** set-beat: patch a beat's label / advance mode (click|with-prev|auto) / autoDelayMs. */
export async function setBeat(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  patch: { label?: string; advance?: "click" | "with-prev" | "auto"; autoDelayMs?: number },
): Promise<void> {
  await mutateDeck(root, deckId, "set_beat", (deck) => {
    mustSlide(deck, slideId);
    slideOps.setBeat(deck, slideId, beatId, patch);
  });
}

/** reorder-beats: set a slide's beat order (beat 0, the resting state, is pinned). */
export async function reorderBeats(root: string, deckId: string, slideId: string, order: string[]): Promise<void> {
  await mutateDeck(root, deckId, "reorder_beats", (deck) => {
    mustSlide(deck, slideId);
    slideOps.reorderBeats(deck, slideId, order);
  });
}

/** move-track: move a track (by id) into another beat on the same slide. */
export async function moveTrack(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
  toBeatId: string,
  at?: number,
): Promise<void> {
  await mutateDeck(root, deckId, "move_track", (deck) => {
    mustSlide(deck, slideId);
    const ok = slideOps.moveTrackToBeat(deck, slideId, trackId, toBeatId, at);
    if (!ok) throw new Error(`track ${trackId} or beat ${toBeatId} not found on ${slideId}`);
  });
}

/** duplicate-track: deep-copy a track in place. Returns the new track id. */
export async function duplicateTrack(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
): Promise<{ trackId: string }> {
  return mutateDeck(root, deckId, "duplicate_track", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.duplicateTrack(deck, slideId, trackId);
    if (!id) throw new Error(`track not found: ${trackId} on ${slideId}`);
    return { trackId: id };
  });
}

/** reorder-tracks: set one beat's track (lane) order. */
export async function reorderTracks(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  order: string[],
): Promise<void> {
  await mutateDeck(root, deckId, "reorder_tracks", (deck) => {
    mustSlide(deck, slideId);
    slideOps.reorderTracks(deck, slideId, beatId, order);
  });
}

/** set-track-enabled: disable/enable a track (disabled = kept but not played). */
export async function setTrackEnabled(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
  enabled: boolean,
): Promise<void> {
  await mutateDeck(root, deckId, "set_track_enabled", (deck) => {
    mustSlide(deck, slideId);
    const ok = slideOps.setTrackEnabled(deck, slideId, trackId, enabled);
    if (!ok) throw new Error(`track not found: ${trackId} on ${slideId}`);
  });
}

/** set-part-visibility: a plot part's resting tri-state — show | animate | mask.
 *  Mask/show DISABLE the part's tracks (they survive for a later re-animate). */
export async function setPartVisibility(
  root: string,
  deckId: string,
  elementId: string,
  part: string,
  mode: "show" | "animate" | "mask",
): Promise<void> {
  await mutateDeck(root, deckId, "set_part_visibility", (deck) => {
    slideOps.setPartVisibility(deck, elementId, part, mode);
  });
}

/** set-part-style: merge a style patch (stroke/fill/strokeWidth/opacity/fontSize/
 *  fontFamily/fontWeight/hidden…) into one plot part's override on a slide
 *  element — through the SAME id-keyed override core the figure editor writes
 *  (ops.mergePartOverride). Null values delete keys. */
export async function setPartStyle(
  root: string,
  deckId: string,
  elementId: string,
  part: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<void> {
  await mutateDeck(root, deckId, "set_part_style", (deck) => {
    const found = slideOps.findElement(deck, elementId);
    if (!found || found.el.type !== "plot") throw new Error(`plot element not found: ${elementId}`);
    slideOps.setPartStyle(deck, elementId, part, patch);
  });
}

/** Resolve a plot's manifest for suggestion/compat gating: the element's
 *  authored source paths, then the plots/ convention, then fig/assets/ by id
 *  (figure-derived copies from Send to deck / add_slide_figure). */
async function readPlotManifest(
  root: string,
  el: { assetId: string; source?: { svgPath?: string; manifestPath?: string } },
): Promise<FluxPlotManifest | undefined> {
  const candidates: string[] = [];
  if (el.source?.manifestPath) candidates.push(el.source.manifestPath);
  if (el.source?.svgPath) candidates.push(el.source.svgPath.replace(/\.svg$/i, ".fluxplot.json"));
  candidates.push(j("plots", `${el.assetId}.fluxplot.json`));
  candidates.push(j("fig", "assets", `${el.assetId}.fluxplot.json`));
  for (const rel of candidates) {
    try {
      return JSON.parse(await fs.readFile(safeJoin(root, rel), "utf8")) as FluxPlotManifest;
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

/** animate-part: ensure ONE plot part animates in — re-enables existing tracks
 *  (preserving authored timing) or adds the plot's suggested default reveal.
 *  Returns the beat index used. */
export async function animatePartVerb(
  root: string,
  deckId: string,
  slideId: string,
  elementId: string,
  part: string,
  beatIndex?: number,
): Promise<{ beatIndex: number }> {
  return mutateDeck(root, deckId, "animate_part", async (deck) => {
    mustSlide(deck, slideId);
    const found = slideOps.findElement(deck, elementId);
    if (!found || found.el.type !== "plot") throw new Error(`plot element not found: ${elementId}`);
    const manifest = await readPlotManifest(root, found.el);
    const bi = animatePart(deck, slideId, elementId, part, manifest, beatIndex);
    if (bi < 0) throw new Error(`slide not found: ${slideId}`);
    return { beatIndex: bi };
  });
}

/** animate-element: give a whole element (text / shape / line / image / plot)
 *  an enter or exit animation with per-kind defaults — the non-plot analog of
 *  animate-part. `part` narrows to a named plot part. Returns the beat index +
 *  track id. */
export async function animateElementVerb(
  root: string,
  deckId: string,
  slideId: string,
  elementId: string,
  opts: { beatIndex?: number; exit?: boolean; preset?: Track["preset"]; part?: string } = {},
): Promise<{ beatIndex: number; trackId: string }> {
  return mutateDeck(root, deckId, "animate_element", (deck) => {
    mustSlide(deck, slideId);
    const r = animateElement(deck, slideId, elementId, opts);
    if (!r) throw new Error(`element not found: ${elementId} on ${slideId}`);
    return r;
  });
}

/** Resolve the explicit PROJECT-relative source paths of a project plot asset
 *  (the project manifest's plots index first, then the conventional
 *  locations). A content target lives only in the track's `to`, never as an
 *  element, so a bare assetId left the GUI preview unable to resolve
 *  figure-derived targets — resolvers must never guess. */
async function resolveAssetSource(root: string, assetId: string): Promise<{ svgPath?: string; manifestPath?: string }> {
  const man = (await loadManifest(root).catch(() => null)) as unknown as {
    plots?: { id: string; path?: string; svgPath?: string; manifestPath?: string }[];
  } | null;
  const entry = man?.plots?.find((p) => p.id === assetId);
  let svgPath = entry?.svgPath ?? entry?.path;
  let manifestPath = entry?.manifestPath;
  if (!svgPath) {
    for (const sp of [j("plots", `${assetId}.svg`), j("fig", "assets", `${assetId}.svg`)]) {
      try { await fs.access(safeJoin(root, sp)); svgPath = sp; break; } catch { /* next candidate */ }
    }
  }
  if (svgPath && !manifestPath) {
    const mp = svgPath.replace(/\.svg$/i, ".fluxplot.json");
    try { await fs.access(safeJoin(root, mp)); manifestPath = mp; } catch { /* no sibling manifest */ }
  }
  return { ...(svgPath ? { svgPath } : {}), ...(manifestPath ? { manifestPath } : {}) };
}

/** become: the third way of transforming. `sourceId` turns into either another
 *  object on the slide (`targetId` — consumed, its evaluated state becomes the
 *  source's endpoint, kind included) or, for a plot, another project plot
 *  (`assetId` — the data-only form: the frame stays, the content becomes the
 *  other plot's; structurally incompatible pairs crossfade and are refused
 *  unless `force`). Twin of the GUI's Become pick. */
export async function become(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  sourceId: string,
  opts: { targetId?: string; assetId?: string; duration?: number; start?: number; easing?: import("../src/lib/slide/types").EasingToken; force?: boolean } = {},
): Promise<{ trackId: string; targetId?: string; assetId?: string }> {
  if (!!opts.targetId === !!opts.assetId) throw new Error("become needs exactly one of --target <elementId> or --asset <assetId>");
  return mutateDeck(root, deckId, "become", async (deck) => {
    mustSlide(deck, slideId);
    if (opts.targetId) {
      const result = slideOps.becomeTransform(deck, slideId, beatId, sourceId, opts.targetId, {
        ...(opts.duration != null ? { duration: opts.duration } : {}),
        ...(opts.start != null ? { start: opts.start } : {}),
        ...(opts.easing != null ? { easing: opts.easing } : {}),
      });
      if (!result) throw new Error(`beat not found: ${beatId} on ${slideId}`);
      return { trackId: result.trackId, targetId: result.targetId };
    }
    const assetId = opts.assetId!;
    const found = slideOps.findElement(deck, sourceId);
    if (!found || found.el.type !== "plot") throw new Error(`plot element not found: ${sourceId} (the data-only form needs a plot source)`);
    if (!opts.force) {
      const A = await readPlotManifest(root, found.el);
      const B = await readPlotManifest(root, { assetId });
      const [cand] = listMorphCandidates(A, [{ assetId, manifest: B }]);
      if (!cand?.compatible) throw new Error(`become ${found.el.assetId} → ${assetId}: structurally incompatible (no shared tweenable series) — playback would crossfade. Pass force to author anyway.`);
    }
    const paths = await resolveAssetSource(root, assetId);
    const t = slideOps.setTransform(deck, slideId, beatId, sourceId, {
      toAssetId: assetId, ...paths,
      ...(opts.duration != null ? { duration: opts.duration } : {}),
      ...(opts.start != null ? { start: opts.start } : {}),
      ...(opts.easing != null ? { easing: opts.easing } : {}),
    });
    if (!t?.id) throw new Error(`beat not found: ${beatId} on ${slideId}`);
    return { trackId: t.id, assetId };
  });
}

// --------------------------------------------------------------------------
// export — the portable .html, fully headless (no browser)
// --------------------------------------------------------------------------
function assetMime(kind: string): string {
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml",
  };
  return m[kind] ?? "application/octet-stream";
}

/** Gather everything a deck needs to render offline: deck-local media + fig/-
 *  resolved media (BY ID) → data URIs (+ display sizes for crop rendering),
 *  semantic plots (incl. morph targets) → inline SVG + manifest. Best-effort:
 *  a missing asset is simply absent (the element shows its placeholder) — but
 *  every gap that would make the export DIVERGE from the editor is reported in
 *  `warnings` so the caller can surface it instead of shipping a silently-
 *  broken file. */
export async function gatherDeckPayload(
  root: string,
  deckId: string,
  slideId?: string,
  opts: { refreshSources?: boolean; videoUrl?: import("../src/lib/slide/payload").SlidePayloadIO["videoUrl"] } = {},
): Promise<{ payload: ExportPayload; warnings: string[] }> {
  const sourceWarnings: string[] = [];
  if (opts.refreshSources !== false && await exists(safeJoin(root, "fig/index.json"))) {
    const synced = await syncFigureAssets(root);
    sourceWarnings.push(...synced.warnings, ...synced.missing.map((p) => `${p}: source is missing; the last accepted Figure asset was retained`));
  }
  const deck = opts.refreshSources === false ? await loadDeck(root, deckId) : await withDeckMutation(root, async owned => {
    const loaded = await loadDeck(root, deckId);
    const externalChanged = reconcileDeckExternalAssetSizes(loaded, await externalDeckAssetMetadata(root, loaded));
    const model = deckSourceProject(loaded);
    const io = { exists, readText: (p: string) => fs.readFile(p, "utf8"), writeText,
      remove: (p: string) => fs.rm(p, { force: true }) };
    const plan = await planSourceUpdates(root, model, io, { assetBase: `slides/${deckId}` });
    for (const status of plan.statuses) if (status.status === "error" || status.status === "missing")
      sourceWarnings.push(`${status.path}: ${status.detail ?? status.status}`);
    const writes = new Map<string, GenerationWrite>();
    if (plan.updates.length) {
      await writeSourceUpdates(root, plan.updates, {writeText:async(p,t)=>{writes.set(path.relative(root,p).split(path.sep).join("/"),t)},remove:async p=>{writes.set(path.relative(root,p).split(path.sep).join("/"),null)}}, model, { assetBase: `slides/${deckId}` });
      applyDeckSourceUpdates(loaded, plan.updates);
    }
    if (plan.updates.length || externalChanged) await saveDeckUnlocked(root, loaded, owned, writes);
    return loaded;
  });
  await ensureDom();
  if (slideId) {
    const slide = deck.slides.find(s => s.id === slideId);
    if (!slide) throw new Error(`Slide not found: ${slideId}`);
    deck.slides = [slide];
    const used = slideAssetIds(slide);
    deck.assets = deck.assets.filter(asset => used.has(asset.id));
  }
  const result = await gatherPayload(root, deck, { readText: p => fs.readFile(p, "utf8"), readFile: p => fs.readFile(p), videoUrl: opts.videoUrl });
  return { ...result, warnings: [...sourceWarnings, ...result.warnings] };
}

/** export-deck: gather + emit the self-contained .html (defaults to
 *  exports/<deckId>.html). Journals the export. */
export async function exportDeck(
  root: string,
  deckId: string,
  opts: { out?: string; refreshSources?: boolean } = {},
): Promise<{ path: string; bytes: number; warnings: string[] }> {
  const { payload, warnings: gatherWarnings } = await gatherDeckPayload(root, deckId, undefined, { refreshSources: opts.refreshSources });
  const { html, bytes, warnings } = await exportDeckHtml(payload);
  const out = opts.out ?? safeJoin(root, j("exports", `${deckId}.html`));
  await writeText(out, html);
  await journal(root, { action: "export_deck", deck: deckId, bytes });
  return { path: out, bytes, warnings: [...gatherWarnings, ...warnings] };
}

export interface ValidateDeckResult {
  ok: boolean;
  checked: number;
  errors: string[];
  /** Non-fatal findings: dangling beat targets (tolerated, surfaced, never
   *  auto-pruned) and similar advisory diagnostics. */
  warnings: string[];
}

/** validate-deck: check one deck (or every deck) against the bundled deck
 *  schema; report dangling beat targets as WARNINGS (not errors). */
export async function validateDeck(root: string, deckId?: string): Promise<ValidateDeckResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const v = ajv.compile(SCHEMAS.deck);
  const errors: string[] = [];
  const warnings: string[] = [];
  let checked = 0;
  const checkOne = async (id: string) => {
    const rel = deckRel(id);
    const p = safeJoin(root, rel);
    if (!(await exists(p))) {
      errors.push(`${rel}: missing`);
      return;
    }
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(await fs.readFile(p, "utf8"));
    } catch (e) {
      errors.push(`${rel}: not valid JSON (${(e as Error).message})`);
      return;
    }
    if (!v(data)) {
      for (const e of v.errors ?? []) errors.push(`${rel}: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
      return;
    }
    for (const d of slideOps.danglingTrackTargets(data as Deck)) {
      warnings.push(`${rel}: slide "${d.slideId}" beat "${d.beatId}" targets a missing element "${d.target}" (tolerated — the track no-ops; undo/re-add the element to restore it)`);
    }
  };
  if (deckId) {
    await checkOne(deckId);
  } else {
    for (const d of await listDecks(root)) await checkOne(d.id);
  }
  return { ok: errors.length === 0, checked, errors, warnings };
}
