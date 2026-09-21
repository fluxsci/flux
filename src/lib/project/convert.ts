import { referenceSyncBridgeIO } from './referenceSyncBridgeIO';
import { figureSnapshotBridgeIO } from "./figureSnapshotBridgeIO";
import { generationBridgeIO } from "./generationBridgeIO";
// ---------------------------------------------------------------------------
// Cross-conversion (slide-migration §3.9) — basic, deliberate, one shared
// clone core (deckProject.cloneContentWithFreshIds):
//
//   • sendFigureToDeck  — figure mode → append a paper figure's content to a
//     deck as a NEW slide (fresh ids, native size — same 96/in ruler — with
//     fit-to-frame only if the figure exceeds the stage). Assets stay
//     referenced BY ID (the deck resolves them from fig/ at load — no copy).
//     The headless twin is the repurposed `add_slide_figure` verb; both call
//     slideOps.addFigureContentToSlide, so semantics cannot drift.
//
//   • sendSlideToCanvas — slide mode → add a REAL paper figure (fresh-id clone
//     of the slide's content; overlay/beats dropped) to a fig/ canvas. It will
//     appear in @fig — that is correct; it is now a figure. Deck-owned asset
//     bytes are copied INTO fig/assets/ (a paper figure must be self-contained
//     in fig/); fig-owned assets already live there.
//
// Both are disk-level model ops (load → mutate through the shared pure cores →
// save through the shared persistence core) on the SUBSYSTEM the current mode
// does NOT own — safe because tenancy + mutual eviction guarantee the other
// mode has no live store to race (its next mount reloads from disk, and the
// revision watchers notify it).
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import { readFigureSnapshot, requireCompleteFigureSnapshot, type FigureSnapshot } from "./figureSnapshot";
import { withIpcLock } from "../references/libLock";
import { validateModel, validateDeckFile } from "./validate";
import type { Figure, Asset } from "../types";
import type { Deck, Slide } from "../slide/types";
import * as ops from "../ops";
import * as slideOps from "../slide/ops";
import { readDeck, writeDeckDirect, listProjectDecks, resolveDeckAssets } from "./slideBridge";
import { createDeck as createDeckModel } from "../slide/ops";
import { cloneContentWithFreshIds } from "../slide/deckProject";
import { fileBridge, joinPath, type FileBridge } from "./types";
import { planFigSave, executeFigSave, sortedCanvasMeta, type FigIndexFile } from "./figfiles";
import { project as figProject, embeddedProjectRoot } from "../store";
import { getAssetData, dataUrlToBytes } from "../assets";
import { plotManifests, plotRecipes } from "../plot/store";
import { isDerivedManifest } from "../plot/derive";
import { newId } from "../ids";
import { reconcileDeckExternalAssetSizes } from "../slide/sourceSync";
import { storedAssetPath } from "./assetPath";
import { commitTextGeneration, recoverTextGeneration, type TextGenerationIO, type GenerationWrite } from "./textGeneration";
import { stageFigureRegistration } from "./figureGeneration";
import { prepareFigureReferenceUpdate, commitFigureReferenceUpdate, recoverFigureReferenceUpdate, releaseFigureReferenceUpdate } from "./figureReferenceSync";

export { listProjectDecks };

/** The project's fig/ canvases (id + name), for the Send-to-canvas picker. */
export async function listFigCanvases(root: string): Promise<{ id: string; name: string }[]> {
  const fig = fileBridge();
  if (!fig) return [];
  try {
    const p = joinPath(root, "fig", "index.json");
    if (!(await fig.exists(p))) return [];
    return sortedCanvasMeta(JSON.parse(await fig.readText(p)) as FigIndexFile).map(c => ({ id: c.id, name: c.name }));
  } catch { return []; }
}

const generationIO = (fig: FileBridge, root: string): TextGenerationIO => generationBridgeIO(root, fig);
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function captureOwner(root: string) {
  const owner = get(embeddedProjectRoot);
  if (owner !== null && owner !== root) throw new Error("Conversion does not own this project");
  return () => { if (get(embeddedProjectRoot) !== owner) throw new Error("Project changed while conversion was prepared"); };
}
async function assertSnapshot(snapshot: FigureSnapshot, io: TextGenerationIO) {
  for (const [rel, baseline] of snapshot.baselines) if (await io.read(rel) !== baseline) throw new Error(`Figures changed while conversion was prepared: ${rel}`);
}
/** Read every asset used by the complete figure model, not only the selected
 * canvas. exists() cannot establish that the accepted scientific bytes can be read. */
async function figureAssets(fig: FileBridge, root: string, snapshot: FigureSnapshot) {
  const required = new Set(snapshot.project.figures.flatMap(f => f.elements.flatMap(e => "assetId" in e ? [e.assetId] : [])));
  const bytes = new Map<string, Uint8Array>();
  for (const id of required) {
    const asset = snapshot.project.assets.find(a => a.id === id);
    if (!asset?.path) throw new Error(`Missing conversion asset: ${id}`);
    const rel = `fig/${storedAssetPath(asset.path)}`;
    const abs = fig.projectAssetPath ? await fig.projectAssetPath(root, rel) : joinPath(root, rel);
    bytes.set(id, new Uint8Array(await fig.readFile(abs)));
    if (asset.kind === "svg") for (const suffix of ["fluxplot", "recipe"]) {
      const sidecar = joinPath(root, "fig", "assets", `${id}.${suffix}.json`);
      if (await fig.exists(sidecar)) JSON.parse(await fig.readText(sidecar));
    }
  }
  return bytes;
}
interface AssetWrite { path: string; bytes: Uint8Array }
async function prepareAbsentWrite(fig: FileBridge, root: string, writes: AssetWrite[], rel: string, bytes: Uint8Array) {
  const abs = joinPath(root, storedAssetPath(rel));
  if (await fig.exists(abs)) {
    if (!equalBytes(new Uint8Array(await fig.readFile(abs)), bytes)) throw new Error(`Conversion asset path contains different bytes: ${rel}`);
  } else writes.push({ path: rel, bytes });
}
async function publishAssets(fig: FileBridge, root: string, writes: AssetWrite[], assertOwner: () => Promise<void>) {
  for (const item of writes) {
    await assertOwner();
    const abs = joinPath(root, item.path);
    // A nonparticipating writer may have arrived since preflight. Never
    // overwrite those bytes, including an unindexed asset from an earlier save.
    if (await fig.exists(abs)) {
      if (!equalBytes(new Uint8Array(await fig.readFile(abs)), item.bytes)) throw new Error(`Conversion asset changed: ${item.path}`);
      continue;
    }
    await fig.mkdir(abs.slice(0, abs.lastIndexOf("/")));
    await assertOwner();
    await fig.writeFile(abs, item.bytes);
    await fig.fsyncDir?.(abs.slice(0, abs.lastIndexOf("/")));
  }
}
function sourceAssets(elements: Figure["elements"]) {
  const ids = new Set(elements.flatMap(e => "assetId" in e ? [e.assetId] : []));
  const metadata = structuredClone(get(figProject).assets);
  const manifests = structuredClone(get(plotManifests)), recipes = structuredClone(get(plotRecipes));
  const source = new Map<string, { asset: Asset; bytes: Uint8Array; manifest?: string; recipe?: string }>();
  for (const id of ids) {
    const asset = metadata.find(a => a.id === id), url = getAssetData(id);
    if (!asset || !url) throw new Error(`Missing conversion asset: ${id}`);
    const man = manifests[id];
    source.set(id, { asset, bytes: dataUrlToBytes(url),
      ...(man && !isDerivedManifest(man) ? { manifest: JSON.stringify(man, null, 2), ...(recipes[id] === undefined ? {} : { recipe: JSON.stringify(recipes[id], null, 2) }) } : {}),
    });
  }
  return source;
}

/** Figure → deck uses an immutable invocation snapshot. Saved figure assets
 * remain by-id references; unsaved assets are copied into the destination deck. */
export async function sendFigureToDeck(root: string, figure: Pick<Figure, "name" | "elements" | "groups">, deckId: string | null): Promise<{ deckId: string; slideId: string; title: string }> {
  const fig = fileBridge(); if (!fig) throw new Error("no file bridge");
  const captured = structuredClone(figure), source = sourceAssets(captured.elements), localOwner = captureOwner(root);
  const sourceErrors = validateModel({ version: 2, name: "Conversion", canvases: [{ id: "source", name: "Source" }], figures: [{ ...captured, id: "source-figure", canvasId: "source", x: 0, y: 0, width: 1, height: 1 }], assets: [...source.values()].map(v => v.asset), palette: [] });
  if (sourceErrors.length) throw new Error(sourceErrors.join("; "));
  return withIpcLock("project", "project", async projectLease => withIpcLock("project", "slides", async slideLease => {
    const assertOwner = async () => { localOwner(); await projectLease.assertOwned?.(); await slideLease.assertOwned?.(); };
    const io = generationIO(fig, root);
    await withIpcLock("project", "manifest", async manifestLease => recoverTextGeneration(io,async()=>{await assertOwner();await manifestLease.assertOwned?.()}), { root });
    const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotBridgeIO(root, fig)));
    const savedBytes = await figureAssets(fig, root, snapshot);
    const deck = deckId ? await readDeck(root, deckId) : createDeckModel({ title: `${captured.name} deck`, withTitleSlide: false });
    if (!deck) throw new Error(`deck not found or invalid: ${deckId}`);
    // Deferred resolution is read-only: conversion must never rebase or warm
    // another resident editor's caches merely by inspecting its target.
    const resolved = await resolveDeckAssets(root, deck, () => false, true);
    const required = new Set(deck.slides.flatMap(s => [...s.elements.flatMap(e => "assetId" in e ? [e.assetId] : []), ...s.beats.flatMap(b => b.tracks.flatMap(t => t.to?.assetId ? [t.to.assetId] : []))]));
    for (const id of required) if (!resolved.data[id]) throw new Error(`Missing conversion target asset: ${id}`);
    const writes: AssetWrite[] = [];
    for (const [id, value] of source) {
      if (resolved.data[id] && !equalBytes(dataUrlToBytes(resolved.data[id]), value.bytes)) throw new Error(`Conversion asset ${id} has different bytes in the destination deck`);
      const disk = savedBytes.get(id);
      if (resolved.data[id] || disk && equalBytes(disk, value.bytes)) continue;
      if (deck.assets.some(a => a.id === id)) throw new Error(`Conversion destination asset ${id} is unreadable`);
      const rel = `assets/${id}.${value.asset.kind}`;
      deck.assets.push({ ...value.asset, path: rel });
      await prepareAbsentWrite(fig, root, writes, `slides/${deck.id}/${rel}`, value.bytes);
      for (const [suffix, text] of [["fluxplot", value.manifest], ["recipe", value.recipe]] as const) if (text !== undefined) await prepareAbsentWrite(fig, root, writes, `slides/${deck.id}/assets/${id}.${suffix}.json`, new TextEncoder().encode(text));
    }
    reconcileDeckExternalAssetSizes(deck, resolved.assets);
    const added = slideOps.addSlide(deck, { name: captured.name, layout: "full-bleed" });
    slideOps.addFigureContentToSlide(deck, added.id, captured);
    reconcileDeckExternalAssetSizes(deck, [...snapshot.project.assets, ...[...source.values()].map(v => v.asset)]);
    const errors = validateDeckFile(deck); if (errors.length) throw new Error(errors.join("; "));
    await assertSnapshot(snapshot, io); await assertOwner();
    await publishAssets(fig, root, writes, assertOwner);
    await assertSnapshot(snapshot, io);
    await writeDeckDirect(root, deck, { assertOwned: assertOwner, ...(deckId ? {} : { expectedText: null }) });
    return { deckId: deck.id, slideId: added.id, title: deck.title };
  }, { root }), { root });
}

/** Slide → Figure reads the complete destination and all dependencies before
 * any write. Canonical Figure files and the fresh manifest share one journal. */
export async function sendSlideToCanvas(root: string, slide: Slide, deck: Pick<Deck, "id" | "stage" | "background" | "theme" | "assets">, canvasId: string | null): Promise<{ figureId: string; name: string; canvasId: string }> {
  const fig = fileBridge(); if (!fig) throw new Error("no file bridge");
  if (slide.elements.some(e => e.type === "video")) throw new Error("Video clips belong to slides. Remove the clips before sending this slide to a Figure canvas.");
  const sourceSlide = structuredClone(slide), sourceDeck = structuredClone(deck), source = sourceAssets(sourceSlide.elements), localOwner = captureOwner(root);
  return withIpcLock("project", "project", async projectLease => withIpcLock("project", "slides", async slideLease => {
    const assertOwner = async () => { localOwner(); await projectLease.assertOwned?.(); await slideLease.assertOwned?.(); };
    const io = generationIO(fig, root);
    await withIpcLock("project", "manifest", async manifestLease => recoverTextGeneration(io,async()=>{await assertOwner();await manifestLease.assertOwned?.()}), { root });
    await recoverFigureReferenceUpdate(root, referenceSyncBridgeIO(root, fig));
    const snapshot = requireCompleteFigureSnapshot(await readFigureSnapshot(figureSnapshotBridgeIO(root, fig)));
    const savedBytes = await figureAssets(fig, root, snapshot), model = snapshot.project;
    const beforeFigures = structuredClone(model.figures), writes: AssetWrite[] = [];
    for (const [id, value] of source) {
      const prior = model.assets.find(a => a.id === id);
      if (prior) {
        if (!prior.path) throw new Error(`Missing conversion asset: ${id}`);
        const disk = savedBytes.get(id) ?? new Uint8Array(await fig.readFile(joinPath(root, "fig", storedAssetPath(prior.path))));
        if (!equalBytes(disk, value.bytes)) throw new Error(`Conversion asset ${id} has different bytes in the Figure project`);
        continue;
      }
      const rel = `assets/${id}.${value.asset.kind}`;
      model.assets.push({ ...value.asset, path: rel });
      await prepareAbsentWrite(fig, root, writes, `fig/${rel}`, value.bytes);
      for (const [suffix, text] of [["fluxplot", value.manifest], ["recipe", value.recipe]] as const) if (text !== undefined) await prepareAbsentWrite(fig, root, writes, `fig/assets/${id}.${suffix}.json`, new TextEncoder().encode(text));
    }
    let cid = canvasId;
    if (cid && !model.canvases.some(c => c.id === cid)) throw new Error(`Conversion destination canvas no longer exists: ${cid}`);
    if (!cid) { cid = newId("canvas"); model.canvases.push({ id: cid, name: `Canvas ${model.canvases.length + 1}` }); }
    const cloned = cloneContentWithFreshIds(sourceSlide.elements, sourceSlide.groups);
    const created = ops.createFigure(model, { canvasId: cid, name: sourceSlide.name ?? "Slide", width: sourceDeck.stage.width, height: sourceDeck.stage.height, background: sourceSlide.background ?? sourceDeck.background ?? "#ffffff" });
    created.elements = cloned.elements;
    if (Object.keys(cloned.groups).length) created.groups = cloned.groups;
    if (sourceSlide.guides) created.guides = structuredClone(sourceSlide.guides);
    const errors = validateModel(model); if (errors.length) throw new Error(errors.join("; "));
    const plan = planFigSave(model, snapshot.index, snapshot.baselines);
    await assertSnapshot(snapshot, io); await assertOwner();
    // Reference preflight happens before asset publication as well. Adding a
    // Figure usually leaves existing stable labels untouched, but use the
    // same coordinator as an ordinary Figure save when meaning does change.
    const references = await prepareFigureReferenceUpdate(root, beforeFigures, model.figures, referenceSyncBridgeIO(root, fig), { index: snapshot.index, figureFiles: [...plan.canvases, plan.index] });
    try {
      await withIpcLock("project", "manifest", async manifestLease => {
        const manifestBefore = await io.read("project.json");
        if (manifestBefore === null) throw new Error("Conversion requires project.json");
        const registration = new Map<string, GenerationWrite>();
        await stageFigureRegistration(io, JSON.parse(plan.index.text) as FigIndexFile, registration);
        await assertSnapshot(snapshot, io); await assertOwner(); await manifestLease.assertOwned?.();
        // New immutable asset files may survive an interrupted save as safe
        // unindexed orphans; no pre-existing asset is ever overwritten here.
        await publishAssets(fig, root, writes, assertOwner);
        await assertSnapshot(snapshot, io);
        if (await io.read("project.json") !== manifestBefore) throw new Error("Manifest changed while conversion was prepared");
        const canonical = new Map<string, GenerationWrite>();
        await executeFigSave(plan, { read: io.read, write: async (rel, text) => { canonical.set(rel, text); } });
        for (const [rel, text] of registration) canonical.set(rel, text);
        for (const rel of [".meta", "fig", "fig/canvases", "fig/captions"]) await fig.mkdir(joinPath(root, rel));
        await commitTextGeneration(io, canonical, async () => { await assertOwner(); await manifestLease.assertOwned?.(); });
      }, { root });
      await commitFigureReferenceUpdate(root, references, referenceSyncBridgeIO(root, fig));
    } catch (error) { await releaseFigureReferenceUpdate(root, references); throw error; }
    const host = globalThis as { fig?: { journalAppend?: (e: unknown) => void } };
    host.fig?.journalAppend?.({ action: "send_slide_to_canvas", target: created.id, client: "human" });
    return { figureId: created.id, name: created.name, canvasId: cid };
  }, { root }), { root });
}
