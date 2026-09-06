// ---------------------------------------------------------------------------
// Flux Slide — the GUI presentation-overlay store (slides-are-figures).
//
// The deck's STATIC content (elements/groups/guides/backgrounds) lives in the
// app-global figure store (src/lib/store.ts `project`), projected one slide =
// one Figure on the synthetic "deck" canvas — the figure editor edits it
// directly (tools, inspector, X-ray, presets, clipboard, history). This module
// owns ONLY the presentation overlay the projection strips out:
//
//   • `deckOverlay` — a Deck whose slides carry EMPTY elements (order, beats,
//     transition/notes/camera, stage, theme, defaults, deck background).
//     Elements are never stored here (single source of truth).
//   • the animator cursor (activeBeat, selTrackIds).
//
// Undo is UNIFIED: overlay edits ride the figure store's history through the
// registered history companion (store.registerHistoryCompanion) — a commit
// whose project delta is empty but whose companion changed is still one undo
// step, and Cmd+Z restores both halves together.
//
// Deck-level structural ops (add/delete/duplicate/reorder slide, beats,
// tracks, theme, stage) run through `commitDeckLive`, which composes the live
// Deck (projectIntoDeck), applies ONE pure slide/ops mutation — the exact
// functions flux-core runs headlessly — and decomposes the result back into
// project figures + overlay. One core, two engines, no drift.
// ---------------------------------------------------------------------------

import { writable, get } from "svelte/store";
import type { Asset, Element, Id, Project } from "../types";
import type { Deck, Slide, Track } from "./types";
import {
  project,
  activeFigureId,
  activeCanvasId,
  loadProject,
  commit,
  mutate,
  mutateDisplay,
  editGen,
  clearSelection,
  selection,
  partSelection,
  type HistoryCompanion,
  registerEditorTransactionAdapter,
} from "../store";
import { familyOf } from "./family";
import { applyDeckSourceUpdates, reconcileDeckExternalAssetSizes } from "./sourceSync";
import { setTransform, removeTracks } from "./ops";
import { compileSlide, evaluateSlideState, type SlideFrame } from "./compile";
import { plotManifests } from "../plot/store";
import { diffState } from "./tween";
import { applyTextLayout } from "../text";
import { deckToProject, projectIntoDeck, DECK_CANVAS_ID, slideDefaultBackground } from "./deckProject";

/** The live presentation overlay (null before a deck is loaded). Slides in
 *  here always have `elements: []` and no groups/guides/background — those
 *  live in the projected figure store. */
export const deckOverlay = writable<Deck | null>(null);

/** The animator cursor: which beat of the active slide is current. */
export const activeBeat = writable<number>(0);
/** The animator's track selection (stable Track.ids). The LAST entry is the
 *  "primary". Reconciled against surviving tracks after undo/redo. */
export const selTrackIds = writable<string[]>([]);

/** An edit destination is a deliberate choice, independent from timeline
 *  navigation and playback. It is UI state, never serialized into the deck. */
export type SlideEditDestination = { kind: "design" } | { kind: "after"; beatId: Id };
export const editDestination = writable<SlideEditDestination>({ kind: "design" });
export const slideCanvasPresentation = writable<SlideFrame["presentation"]>({ elementStates: {}, hiddenElementIds: [], partStates: {} });
export function setEditDestination(destination: SlideEditDestination): void {
  endpointEdit.set(null);
  editDestination.set(destination);
  refreshBeatDisplay();
}
export function editAfterBeat(index = get(activeBeat)): void {
  const slide = get(deckOverlay)?.slides.find(s => s.id === get(activeFigureId));
  const beat = slide?.beats[index];
  setEditDestination(index > 0 && beat ? { kind: "after", beatId: beat.id } : { kind: "design" });
}
let suppressEditAdapter = 0;

// Asset ids resolved FROM the project (plots, fig/-owned media) rather than
// owned by the deck — the save fold never writes them into deck.assets and
// never copies their bytes into slides/<id>/assets/.
let externalAssets = new Set<string>();
// Accepted source revisions are external facts, not undoable author edits.
// Keep their metadata outside history so restoring a document cannot bring
// back an obsolete intrinsic size while the SVG cache contains newer bytes.
const acceptedAssetMetadata = new Map<string, Asset>();
export function externalAssetIds(): ReadonlySet<string> {
  return externalAssets;
}

/** Strip a deck to its overlay half: slides keep id/name/layout/presentation,
 *  drop elements/groups/guides/background (those live in the projection). */
export function stripDeckToOverlay(deck: Deck): Deck {
  const d = structuredClone(deck);
  d.slides = d.slides.map((s) => {
    const o: Slide = { id: s.id, elements: [], beats: s.beats };
    if (s.name !== undefined) o.name = s.name;
    if (s.layout !== undefined) o.layout = s.layout;
    if (s.transition !== undefined) o.transition = s.transition;
    if (s.notes !== undefined) o.notes = s.notes;
    if (s.camera !== undefined) o.camera = s.camera;
    return o;
  });
  // Design tokens + assets live in the projected project while loaded; the
  // fold (projectIntoDeck) re-reads them from there. Keeping them here too
  // would be double storage.
  d.palette = [];
  delete d.colorGroups;
  delete d.textStyles;
  d.assets = [];
  return d;
}

/** Load a deck into the LIVE editing stores: static content → the figure
 *  store (deckToProject → loadProject: history reset, dirty cleared), overlay
 *  → this store. `resolvedAssets` = deck.assets + project-resolved assets;
 *  `external` marks the project-resolved ids. */
export function loadDeckModel(deck: Deck, resolvedAssets: Asset[] = deck.assets, external: Set<string> = new Set()): void {
  checkoutBaselines.clear();
  endpointEdit.set(null);
  editDestination.set({ kind: "design" });
  externalAssets = external;
  acceptedAssetMetadata.clear();
  for (const a of resolvedAssets) acceptedAssetMetadata.set(a.id, structuredClone(a));
  const proj = deckToProject(deck, resolvedAssets);
  loadProject(proj, null, { figureIdentity: false });
  deckOverlay.set(stripDeckToOverlay(deck));
  activeCanvasId.set(DECK_CANVAS_ID);
  activeFigureId.set(deck.slides[0]?.id ?? null);
  activeBeat.set(0);
  selTrackIds.set([]);
}

/** Refresh project-owned asset metadata without rewriting the deck document or
 * its current edit destination. Local slide assets remain owned by the deck. */
export function replaceResolvedDeckAssets(assets: Asset[]): void {
  const byId=new Map(assets.map(a=>[a.id,a]));
  for (const a of assets) acceptedAssetMetadata.set(a.id, structuredClone(a));
  mutateDisplay(p=>{p.assets=p.assets.map(a=>externalAssets.has(a.id)&&byId.has(a.id)?structuredClone(byId.get(a.id)!):a);});
}

/** Compose the full live Deck from the two halves (figure store + overlay).
 *  Checked-out endpoint elements fold as their BASE state (the guard). */
export function currentDeck(): Deck | null {
  const o = get(deckOverlay);
  if (!o) return null;
  return projectIntoDeck(get(project), o, { externalAssetIds: externalAssets, baselines: checkoutBaselines });
}

/** The composed live Slide for one slide id (elements from the figure store,
 *  presentation from the overlay) — what the player/renderer consume.
 *  Checked-out elements substitute their BASE state, so thumbnails/preview/
 *  present always see document truth (the canvas alone shows the endpoint). */
export function composedSlide(slideId: Id): Slide | null {
  const o = get(deckOverlay);
  const p = get(project);
  if (!o) return null;
  const os = o.slides.find((s) => s.id === slideId);
  const fig = p.figures.find((f) => f.id === slideId);
  if (!os || !fig) return null;
  const elements = checkoutBaselines.size
    ? fig.elements.map((e) => (checkoutBaselines.has(e.id) ? structuredClone(checkoutBaselines.get(e.id)!) : e))
    : fig.elements;
  const s: Slide = {
    ...os,
    elements,
    ...(fig.groups ? { groups: fig.groups } : {}),
    ...(fig.guides ? { guides: fig.guides } : {}),
  };
  if (fig.background !== slideDefaultBackground(o)) s.background = fig.background;
  return s;
}

// ---------------------------------------------------------------------------
// The GUI deck-op write path — compose → pure op → decompose, in ONE history
// entry (with the presentation overlay riding the history companion).
// ---------------------------------------------------------------------------

// Coalescing (a typing run, a slider drag, an S/A/M paint sweep) folds a burst
// of same-key commits into ONE undo step: the first commit of the run captures
// the pre-state; followers mutate in place. The editGen guard makes reuse
// safe — if ANY other edit/undo landed since, a fresh entry opens.
const coalesceState = { key: null as string | null, gen: -1 };

/** Apply a pure deck op to the LIVE deck: composes the current Deck, runs
 *  `fn`, then writes the result back into the figure store (figures) and the
 *  overlay. One undo step (or part of a coalesced run). Returns fn's result. */
export function commitDeckLive<T>(fn: (deck: Deck) => T, opts?: { coalesce?: string; history?: boolean }): T {
  const o = get(deckOverlay);
  if (!o) throw new Error("no deck loaded");
  let out!: T;
  const key = opts?.coalesce ?? null;
  const continueRun = key !== null && key === coalesceState.key && editGen.n === coalesceState.gen;
  const write = opts?.history === false || continueRun ? mutate : commit;
  suppressEditAdapter++;
  try { write((proj) => {
    const deck = projectIntoDeck(proj, o, { externalAssetIds: externalAssets, baselines: checkoutBaselines });
    out = fn(deck);
    // Decompose: figures ← deck slides (order + content), overlay ← the rest.
    // Checked-out elements keep the STORE's display state (the fold guard
    // substituted their base into `deck`; folding that base back would snap
    // the canvas out of the endpoint mid-checkout).
    const keepDisplay = (slideId: Id, els: Element[]): Element[] => {
      if (!checkoutBaselines.size) return els;
      const live = proj.figures.find((f) => f.id === slideId);
      if (!live) return els;
      return els.map((e) => {
        if (!checkoutBaselines.has(e.id)) return e;
        checkoutBaselines.set(e.id, structuredClone(e));
        return live.elements.find((x) => x.id === e.id) ?? e;
      });
    };
    const defaultBg = slideDefaultBackground(deck);
    proj.name = deck.title;
    proj.figures = deck.slides.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      canvasId: DECK_CANVAS_ID,
      x: 0,
      y: 0,
      width: deck.stage.width,
      height: deck.stage.height,
      background: s.background ?? defaultBg,
      elements: keepDisplay(s.id, s.elements),
      ...(s.groups ? { groups: s.groups } : {}),
      ...(s.guides ? { guides: s.guides } : {}),
    }));
    proj.assets = [
      ...deck.assets,
      ...proj.assets.filter((a) => externalAssets.has(a.id) && !deck.assets.some((d) => d.id === a.id)),
    ];
    // The overlay store object is REPLACED after the write (below); mutate the
    // captured `o` here so the companion snapshot (taken by beginGesture before
    // this callback) holds the true pre-state.
    Object.assign(o, stripDeckToOverlay(deck));
  }); } finally { suppressEditAdapter--; }
  // Publish a FRESH identity: Svelte 5's store→rune bridge dedupes on
  // referential equality, so re-setting the same object would not re-render
  // `$deckOverlay` consumers (the filmstrip's {#each} would go stale).
  deckOverlay.set({ ...o });
  reconcileCursor();
  // deck structure may have changed what the canvas should show at this beat
  // (track added/retimed/disabled/deleted, state edited from the properties
  // pane) — re-derive BEFORE recording the coalescing generation, so a
  // display mutate's editGen bump is folded into the run and coalesced
  // continuations still match.
  refreshBeatDisplay();
  coalesceState.key = key;
  coalesceState.gen = editGen.n;
  return out;
}

/** End the current coalesced run (text blur, pointer-up) so the next commit
 *  begins a fresh undo step. */
export function sealHistory(): void {
  coalesceState.key = null;
}

/** The history companion provider (registered by SlideMode while mounted):
 *  snapshots the overlay next to every project snapshot so undo/redo restore
 *  both halves together. The endpoint-checkout state (which endpoint is
 *  checked out + the captured base elements) rides the SAME snapshot, so
 *  undo across the checkout boundary is exact: entries from before the
 *  checkout restore endpointEdit = null (auto-exit), entries from within
 *  restore the checkout AND re-derive the display element from the restored
 *  track state (invariant: store element ≡ pre ⊕ activeState, always). */
export function overlayHistoryCompanion(): HistoryCompanion {
  return {
    capture: () => ({
      overlay: structuredClone(get(deckOverlay)),
      beat: get(activeBeat),
      destination: structuredClone(get(editDestination)),
      checkout: structuredClone(get(endpointEdit)),
      baselines: [...checkoutBaselines.entries()].map(([id, el]) => [id, structuredClone(el)] as const),
    }),
    restore: (s) => {
      const snap = s as
        | { overlay: Deck | null; beat: number; destination?: SlideEditDestination; checkout?: EndpointEdit | null; baselines?: (readonly [Id, Element])[] }
        | undefined;
      if (!snap) return;
      checkoutBaselines.clear();
      for (const [id, el] of snap.baselines ?? []) checkoutBaselines.set(id, structuredClone(el));
      let restored = snap.overlay;
      if (restored && acceptedAssetMetadata.size) {
        const canonical = projectIntoDeck(get(project), restored, { externalAssetIds: externalAssets, baselines: checkoutBaselines });
        const ownedUpdates = canonical.assets.flatMap(a => {
          const latest = acceptedAssetMetadata.get(a.id);
          return latest && latest.naturalWidth > 0 && latest.naturalHeight > 0 &&
            (latest.naturalWidth !== a.naturalWidth || latest.naturalHeight !== a.naturalHeight)
            ? [{ assetId: a.id, width: latest.naturalWidth, height: latest.naturalHeight }] : [];
        });
        if (ownedUpdates.length) applyDeckSourceUpdates(canonical, ownedUpdates);
        const externalChanged = reconcileDeckExternalAssetSizes(canonical, [...acceptedAssetMetadata.values()]);
        const rebased = externalChanged || ownedUpdates.length > 0;
        // Rebuild the display from canonical content below; no historical
        // endpoint projection or source baseline may survive this boundary.
        const slides = new Map(canonical.slides.map(slide => [slide.id, slide]));
        mutateDisplay(p => {
          p.assets = p.assets.map(a => {
            const latest = acceptedAssetMetadata.get(a.id);
            return latest ? { ...a, naturalWidth: latest.naturalWidth, naturalHeight: latest.naturalHeight } : a;
          });
          if (rebased) for (const figure of p.figures) {
              const slide = slides.get(figure.id);
              if (slide) figure.elements = slide.elements;
            }
        });
        if (rebased) {
          checkoutBaselines.clear();
          restored = stripDeckToOverlay(canonical);
        }
      }
      deckOverlay.set(restored);
      endpointEdit.set(snap.checkout ?? null);
      editDestination.set(snap.destination ?? { kind: "design" });
      activeBeat.set(snap.beat ?? 0);
      reconcileCursor();
      // the undo restored the PROJECT (display at snapshot time), the overlay
      // (track state at snapshot time), and the baselines — the reconciler
      // re-derives every display from base ⊕ restored state, so the two
      // halves can never disagree (invariant: store el ≡ pre ⊕ activeState).
      refreshBeatDisplay();
    },
  };
}

/** After an undo/redo/op, keep the animator cursor valid: an in-range beat and
 *  a track selection of only still-existing tracks on the active slide. */
export function reconcileCursor(): void {
  const o = get(deckOverlay);
  if (!o) return;
  const sid = get(activeFigureId);
  const slide = o.slides.find((s) => s.id === sid) ?? o.slides[0] ?? null;
  if (get(activeBeat) >= (slide?.beats.length ?? 1)) activeBeat.set(Math.max(0, (slide?.beats.length ?? 1) - 1));
  const liveTracks = new Set(slide?.beats.flatMap((b) => b.tracks.map((t) => t.id)) ?? []);
  selTrackIds.update((ids) => ids.filter((id) => liveTracks.has(id)));
}

// ---------------------------------------------------------------------------
// EXPLICIT EDIT DESTINATION. Design uses canonical object properties. After
// a named step derives the evaluated endpoint into the shared editor and
// captures all subsequent property edits at that exact step. Browsing the
// timeline and sampling playback never change this destination.
//
// Canonical base elements are held outside the display projection; save,
// thumbnail, preview and history fold them back. The synchronous transaction
// adapter translates deliberate edits before any subscriber sees the change.
// ---------------------------------------------------------------------------

export interface EndpointEdit {
  /** Before/after shortcut metadata. The visible editDestination owns edits. */
  end: "t1" | "t2";
  entries: { trackId: Id | null; target: Id }[];
}

/** The selected endpoint shortcut, separate from the explicit destination. */
export const endpointEdit = writable<EndpointEdit | null>(null);

// elementId → its BASE (document beat-0) element. Module-level and
// non-reactive by design (read by every fold).
const checkoutBaselines = new Map<Id, Element>();

/** Read-only view for gates/debug. */
export function checkoutBaselineIds(): ReadonlySet<Id> {
  return new Set(checkoutBaselines.keys());
}



/** Locate a track by id in the OVERLAY (beats live there). */
function overlayTrack(trackId: Id): { slide: Slide; beatIndex: number; track: Track } | null {
  const o = get(deckOverlay);
  if (!o) return null;
  for (const s of o.slides) {
    for (let bi = 0; bi < s.beats.length; bi++) {
      const track = s.beats[bi].tracks.find((t) => t.id === trackId);
      if (track) return { slide: s, beatIndex: bi, track };
    }
  }
  return null;
}

/** THE RECONCILER — recompute what every element of the active slide should
 *  display at the active beat, and make the store match. Idempotent, cheap
 *  (skips no-op writes so it never burns editGen/coalescing on unrelated
 *  commits), history-invisible (mutate). Called on beat/slide changes, after
 *  every deck op, after undo/redo, and around checkout enter/exit. */
export function refreshBeatDisplay(): void {
  const o = get(deckOverlay);
  const sid = get(activeFigureId);
  if (!o || !sid) return;
  const os = o.slides.find((s) => s.id === sid);
  const p = get(project);
  const fig = p.figures.find((f) => f.id === sid);
  if (!os || !fig) return;
  const destination = get(editDestination);
  const k = destination.kind === "after" ? os.beats.findIndex(b => b.id === destination.beatId) : 0;
  if(destination.kind==="after" && k<1) {editDestination.set({kind:"design"});endpointEdit.set(null);}

  // Evaluate from canonical content; appearance and camera stay transient.
  const canonical = composedSlide(sid);
  const frame = canonical && k > 0 ? evaluateSlideState(canonical, k, Infinity, {
    stage: o.stage, plotManifest: id => get(plotManifests)[id],
  }) : null;
  const evaluated = new Map(frame?.elements.map(e => [e.id, e]) ?? []);
  slideCanvasPresentation.set(frame?.presentation ?? {elementStates:{},hiddenElementIds:[],partStates:{},
    unbornElementIds: canonical?.beats.flatMap(b => b.tracks.filter(t => t.ghostFrom).map(t => t.target)) ?? [],
  });
  const wanted = new Set(k > 0 ? fig.elements.map(e=>e.id) : []);

  // 2. Elements leaving the display set restore their base; 3. elements in it
  //    (re)compute their display. One mutate, only when something changed —
  //    a no-op refresh must never burn editGen (it would break commit
  //    coalescing for unrelated typing runs).
  const writes = new Map<Id, Element>();
  for (const [id, base] of [...checkoutBaselines]) {
    if (wanted.has(id)) continue;
    checkoutBaselines.delete(id);
    if (fig.elements.some((e) => e.id === id)) writes.set(id, structuredClone(base));
  }
  for (const target of wanted) {
    const cur = fig.elements.find((e) => e.id === target);
    if (!cur) {
      // dangling (element deleted) — drop the display bookkeeping; the
      // baseline itself rides history via the companion snapshot.
      checkoutBaselines.delete(target);
      continue;
    }
    if (!checkoutBaselines.has(target)) checkoutBaselines.set(target, structuredClone(cur));
    const disp = evaluated.get(target) ?? structuredClone(checkoutBaselines.get(target)!);
    if (disp?.type === "text" && disp.needsLayout) applyTextLayout(disp);
    if (!disp) continue;
    const j = JSON.stringify(disp);
    if (j !== JSON.stringify(cur)) writes.set(target, disp);
  }
  if (writes.size) {
    // mutateDisplay, NOT mutate: this reconciler runs on plain beat navigation /
    // slide switch, and a composed-display write must never mark the deck dirty
    // (it would autosave deck.json on every beat click and pop a spurious
    // external-change banner). editGen still advances so commit-coalescing is
    // unchanged; user mutations separately set dirty.
    mutateDisplay((proj) => {
      const f2 = proj.figures.find((f) => f.id === sid);
      if (!f2) return;
      for (const [id, el] of writes) {
        const i = f2.elements.findIndex((e) => e.id === id);
        if (i >= 0) f2.elements[i] = el;
      }
    });
  }
}

/** Synchronous user-edit boundary, registered with the shared figure store.
 *  Captures only the active slide, never a deck clone, and runs before any
 *  project subscriber. Project notifications cannot author animations. */
export function registerSlideEditAdapter(onUserEdit?:()=>void): () => void {
  return registerEditorTransactionAdapter({
    before(p, context) {
      onUserEdit?.();
      if (suppressEditAdapter) return null;
      const unborn = new Set(get(slideCanvasPresentation).unbornElementIds ?? []);
      if (get(editDestination).kind !== "after" && !unborn.size) return null;
      const sid = get(activeFigureId);
      if (context.figureId && context.figureId !== sid) return null;
      const fig = p.figures.find(f => f.id === sid);
      return fig ? { elements: new Map(fig.elements.map(e => [e.id, structuredClone(e)])), unborn } : null;
    },
    after(p, token) {
      if (!token || suppressEditAdapter) return;
      const { elements: previousElements, unborn } = token as { elements: Map<Id, Element>; unborn: Set<Id> };
      const destination = get(editDestination);
      const o = get(deckOverlay), sid = get(activeFigureId);
      const fig = p.figures.find(f => f.id === sid);
      const slide = o?.slides.find(s => s.id === sid);
      if (!o || !fig || !slide) return;
      const bi = destination.kind === "after" ? slide.beats.findIndex(b => b.id === destination.beatId) : 0;
      let changed = false;
      // Structural metadata belongs to the original object, not a transform.
      const structural = ["name", "groupId", "locked", "hidden", "lockAspect", "styleId", "panelLabel", "source", "manifestRef"] as const;
      let compiled: ReturnType<typeof compileSlide> | null = null;
      for (const el of fig.elements) {
        const previous = previousElements.get(el.id);
        if (!previous) continue; // a new element is an ordinary document edit
        // A future/disabled ghost has no editable frame. Layers may still
        // select, rename or delete its identity, but geometry belongs to its
        // explicitly chosen destination after birth, never this fallback.
        if (unborn.has(el.id)) {
          const restored = structuredClone(previous) as unknown as Record<string, unknown>;
          const current = el as unknown as Record<string, unknown>;
          for (const key of structural) {
            if (key in current) restored[key] = structuredClone(current[key]); else delete restored[key];
          }
          for (const key of Object.keys(current)) delete current[key];
          Object.assign(current, restored);
        }
        const base = checkoutBaselines.get(el.id);
        if (!base) continue;
        for (const key of structural) {
          const rec = el as unknown as Record<string,unknown>, dest = base as unknown as Record<string,unknown>;
          if (key in rec) dest[key] = structuredClone(rec[key]); else delete dest[key];
        }
        if (previous.type === "plot" && el.type === "plot" && base.type === "plot" && previous.assetId !== el.assetId) base.assetId = el.assetId;
        if (bi < 1 || unborn.has(el.id) || !diffState(previous, el)) continue;
        compiled ??= compileSlide({ ...slide, elements: [...previousElements.values()].map(e => checkoutBaselines.get(e.id) ?? e) }, o.stage, {plotManifest: id => get(plotManifests)[id]});
        const pre = compiled.preState(el.id, bi) ?? base;
        const patch = diffState(pre, el) ?? {};
        setTransform(o, sid!, slide.beats[bi].id, el.id, { state: patch, replaceState: true });
        changed = true;
      }
      const surviving = new Set(fig.elements.map(e => e.id));
      const removedBirths = slide.beats.flatMap(b => b.tracks.filter(t => t.ghostFrom && t.id && previousElements.has(t.target) && !surviving.has(t.target)).map(t => t.id!));
      if (removedBirths.length) { removeTracks(o, sid!, removedBirths); changed = true; }
      for (const id of checkoutBaselines.keys()) if (!surviving.has(id)) {
        checkoutBaselines.delete(id);
      }
      if (changed) deckOverlay.set({ ...o });
    },
  });
}

/** Before selects the immediately previous named step (or Design); After
 * selects this step. The visible destination always states where edits go. */
export function enterEndpointEdit(trackIds: Id[], end: "t1" | "t2"): EndpointEdit["entries"] {
  endpointEdit.set(null);
  const entries: EndpointEdit["entries"] = [];
  const targets: Id[] = [];
  for (const trackId of trackIds) {
    const found = overlayTrack(trackId);
    if (!found || familyOf(found.track) !== "transform") continue;
    const target = end === "t1" && found.track.ghostFrom ? found.track.ghostFrom : found.track.target;
    targets.push(target);
    if (end === "t2") {
      entries.push({ trackId, target });
    } else {
      // t1 → the previous transform on the same target (else the base)
      let prev: Track | null = null;
      for (let bi = 0; bi < found.beatIndex; bi++) {
        for (const t of found.slide.beats[bi].tracks) {
          if (!t.disabled && t.target === target && familyOf(t) === "transform") prev = t;
        }
      }
      entries.push({ trackId: prev?.id ?? null, target });
    }
  }
  if (targets.length) {
    selection.set(new Set(targets));
    partSelection.set(null);
  }
  const first = trackIds.length ? overlayTrack(trackIds[0]) : null;
  if (first) {
    const targetIndex = end === "t2" ? first.beatIndex : Math.max(0, first.beatIndex - 1);
    editDestination.set(targetIndex > 0 ? { kind: "after", beatId: first.slide.beats[targetIndex].id } : { kind: "design" });
  }
  endpointEdit.set(entries.length ? { end, entries } : null);
  refreshBeatDisplay();
  return entries;
}

/** Re-derive displays after a PROPERTIES-side edit to a track's state
 *  (dropping a Δ prop, Clear t₂): the sync mirror is one-way (canvas →
 *  track), so track-side edits push back explicitly. */
export function refreshEndpointDisplay(): void {
  refreshBeatDisplay();
}

/** Dismiss the endpoint shortcut without changing the explicit destination. */
export function exitEndpointEdit(): void {
  if (get(endpointEdit) === null) return;
  endpointEdit.set(null);
  refreshBeatDisplay();
}

/** FULL display teardown (mode unmount, deck load, project close): restore
 *  every baseline into the store and clear all display state. */
export function clearBeatDisplay(): void {
  endpointEdit.set(null);
  if (checkoutBaselines.size) {
    const sid = get(activeFigureId);
    // mutateDisplay: restoring composed displays to their base is teardown, not a
    // user edit — it must not dirty the deck (a pending real edit's dirty still
    // stands; mutateDisplay only refrains from SETTING it).
    mutateDisplay((p) => {
      const fig = p.figures.find((f) => f.id === sid);
      if (!fig) return;
      for (const [id, base] of checkoutBaselines) {
        const i = fig.elements.findIndex((e) => e.id === id);
        if (i >= 0) fig.elements[i] = structuredClone(base);
      }
    });
  }
  checkoutBaselines.clear();
  slideCanvasPresentation.set({elementStates:{},hiddenElementIds:[],partStates:{}});
}

// Cursor changes may need to reconcile after a step was removed/reordered,
// but the edit destination remains the explicitly chosen stable step id.
activeBeat.subscribe(() => {
  refreshBeatDisplay();
});

/** Select another slide instantly, restore outgoing base content, and start
 * its editing surface in Design. The timeline may still select its last step. */
export function selectSlide(slideId: Id): void {
  clearBeatDisplay(); // restores the outgoing slide's bases under the OLD figure id
  editDestination.set({ kind: "design" });
  activeFigureId.set(slideId);
  const o = get(deckOverlay);
  const s = o?.slides.find((x) => x.id === slideId);
  activeBeat.set(Math.max(0, (s?.beats.length ?? 1) - 1)); // timeline cursor only
  selTrackIds.set([]);
  clearSelection();
  refreshBeatDisplay(); // in case activeBeat's value didn't change (no notify)
}

/** Clear the slide stores (true project close / tenancy handoff). */
export function clearDeck(): void {
  checkoutBaselines.clear();
  endpointEdit.set(null);
  editDestination.set({kind:"design"});
  slideCanvasPresentation.set({elementStates:{},hiddenElementIds:[],partStates:{}});
  deckOverlay.set(null);
  activeBeat.set(0);
  selTrackIds.set([]);
  externalAssets = new Set();
  acceptedAssetMetadata.clear();
  coalesceState.key = null;
}
