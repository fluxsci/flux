// verify-fluximg-slide-model (pure, hermetic): N-dimensional images (fluximg) in slide decks (stage 2, work package W1b).
//
// What is pinned:
//   A. The deck schema accepts a deck holding an image, refuses a malformed one, and still refuses a deck-OWNED bundle.
//   B. Format 0.8.0 (plan D6): stamped only while a slide holds an image; decks without one keep their stamp and their
//      bytes on BOTH engines (flux-core saveDeck, and the app's fold projectIntoDeck(deckToProject) through the shared
//      write point); an older reader refuses 0.8.0 with the forward-version message, before validation.
//   C. Fold / unfold keeps the element, its view and its crop; the fold never writes the bundle into deck.assets.
//   D. Headless: place-image onto deckId/slideId and onto a bare slide id; set-image-view on the slide's Design and
//      with --beat (that step's Change: to.state.view / crop, Design untouched, one track per step); a linked panel on
//      the same slide follows at the same step; image-info for an element on a slide.
//   E. The tween across three steps (view, crop, view Changes): transformPreState / transformEndState / compile.sample;
//      the ends are exact; a mid-flight sample is a valid recipe for the image with whole planes [needs W1a's tween].
//   F. Diagnostics: a Change view that does not fit the image, a Design view that does not fit, a missing bundle; a
//      deck without images never asks the image lookups.
//   G. Capture law: assetId / source / playback are never a step's state; view and crop are; writeStepState is the
//      one op; a Become into an image hands off, a consume into one and image → other image are refused.
//   H. Send figure to deck (addFigureContentToSlide) and saved slide presets (an image's bundle is never embedded).
//
// Run: node --import tsx scripts/verify-fluximg-slide-model.ts
import "./lib/cssStub.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";

const h = harness("verify-fluximg-slide-model");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "fluximg-slide-model-"));
Object.assign(process.env, isolatedEnv(path.join(scratch, "machine")), { FLUX_NO_MIGRATE: "1" });

const { VERBS } = await import("../flux-core/registry");
const core = await import("../flux-core/index");
const slidesCore = await import("../flux-core/slides");
const { fixtures, writeFixture } = await import("./lib/fluximgFixtures");
const slideOps = await import("../src/lib/slide/ops");
const { deckToProject, projectIntoDeck, slideAssetIds } = await import("../src/lib/slide/deckProject");
const { stripDeckToOverlay } = await import("../src/lib/slide/store");
const { deckSchemaFor, DECK_FEATURES, DECK_EDITABLE } = await import("../src/lib/slide/schemaStamp");
const { DECK_SCHEMA_VERSION } = await import("../src/lib/slide/types");
const { validateDeckFile } = await import("../src/lib/project/validate");
const { isNewerSchema, newerSchemaMessage } = await import("../src/lib/project/types");
const { commitDeckGeneration } = await import("../src/lib/project/deckGeneration");
const { transformPreState, transformEndState, diffState, applyState, lerpElement } = await import("../src/lib/slide/tween");
const { compileSlide } = await import("../src/lib/slide/compile");
const { checkViewPatch } = await import("../src/lib/fluximg/viewCheck");
const { fluximgResolvedAsset } = await import("../src/lib/fluximg/place");
const ops = await import("../src/lib/ops");
type Deck = import("../src/lib/slide/types").Deck;
type FluximgElement = import("../src/lib/fluximg/element").FluximgElement;
type FluximgManifest = import("../src/lib/fluximg/types").FluximgManifest;
type Asset = import("../src/lib/types").Asset;
type Element = import("../src/lib/types").Element;

const verb = (name: string) => VERBS.find((v) => v.name === name)!;
const root = path.join(scratch, "project");
async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const v = verb(name);
  return (await v.handler({ root, transport: "mcp" }, z.object(v.params).parse(args) as Record<string, unknown>)) as T;
}
async function refuses(name: string, args: Record<string, unknown>, pattern: RegExp, label: string): Promise<void> {
  try { await call(name, args); h.fail(`${label}: accepted`); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(pattern.test(m), `${label}: "${m.split("\n")[0]}"`); }
}
const deckFile = (id: string) => path.join(root, "slides", id, "deck.json");
const readDeck = async (id: string): Promise<Deck> => JSON.parse(await fs.readFile(deckFile(id), "utf8"));

/** The app's engine: its slide store holds the projection + the overlay; `currentDeck()` folds them; the ONE write point
 *  (commitDeckGeneration, as slideBridge.saveDeck calls it) publishes. Here over a memory copy of the project's files. */
async function appSave(deck: Deck, files: Map<string, string>): Promise<string> {
  const composed = projectIntoDeck(deckToProject(deck, deck.assets), stripDeckToOverlay(deck));
  const io = { read: async (rel: string) => files.get(rel) ?? null, write: async (rel: string, text: string) => { files.set(rel, text); }, remove: async (rel: string) => { files.delete(rel); } };
  const out = await commitDeckGeneration(io, composed);
  return out.text;
}
const diskFiles = async (deckId: string): Promise<Map<string, string>> => new Map([
  ["project.json", await fs.readFile(path.join(root, "project.json"), "utf8")],
  [`slides/${deckId}/deck.json`, await fs.readFile(deckFile(deckId), "utf8")],
]);

try {
  await core.scaffold(root, { title: "slides with images" });
  const fx = Object.fromEntries(fixtures().map((f) => [f.name, f]));
  for (const name of ["stack_u16", "gray2d_u8", "movie_f32"]) await writeFixture(path.join(root, "plots"), fx[name]);
  const stackManifest = JSON.parse(await fs.readFile(path.join(root, "plots/stack_u16.fluximg/fluximg.json"), "utf8")) as FluximgManifest;
  const nz = stackManifest.pixels.shape[stackManifest.pixels.dims.indexOf("z")];

  // ----------------------------------------------------------------------------------------------------------------
  h.section("A. the deck schema");
  const image = (extra: Partial<FluximgElement> = {}): FluximgElement => ({ type: "fluximg", id: "img", assetId: "img-a", x: 10, y: 10, width: 64, height: 48, rotation: 0, ...extra } as FluximgElement);
  {
    const d = slideOps.createDeck({ id: "schema", title: "S" });
    d.slides[0].elements.push(image({ view: { index: { z: 3 }, channels: [{ range: [10, 900] }] }, crop: { x: 4, y: 4, width: 32, height: 24 } }));
    d.schemaVersion = deckSchemaFor(d);
    h.eq(validateDeckFile(JSON.parse(JSON.stringify(d))), [], "a deck holding an image (view + crop) validates");
    const imgOf = (deck: Deck) => deck.slides[0].elements.find((e) => e.type === "fluximg") as FluximgElement;
    const noAsset = structuredClone(d); delete (imgOf(noAsset) as Partial<FluximgElement>).assetId;
    h.ok(validateDeckFile(noAsset).length > 0, "an image without assetId is refused");
    const badKey = structuredClone(d); (imgOf(badKey) as unknown as { view: Record<string, unknown> }).view.zoom = 2;
    h.ok(validateDeckFile(badKey).length > 0, "an image view with an unknown top-level key is refused (the figure branch's own rule)");
    const owned = structuredClone(d); owned.assets.push({ id: "img-a", name: "x", kind: "fluximg", path: "assets/img-a.fluximg", naturalWidth: 64, naturalHeight: 48 } as Asset);
    h.ok(validateDeckFile(owned).length > 0, "a deck-OWNED bundle (deck.assets kind fluximg) is still refused: a deck never owns one");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("B. format 0.8.0 only with an image; other decks keep their bytes on both engines");
  {
    h.eq(DECK_SCHEMA_VERSION, "0.8.0", "this build reads 0.8.0");
    const d = slideOps.createDeck({ id: "s", title: "S" });
    h.eq(deckSchemaFor(d), "0.6.0", "a featureless deck stamps 0.6.0");
    d.slides[0].elements.push(image());
    h.eq(deckSchemaFor(d), "0.8.0", "an image stamps 0.8.0");
    d.slides[0].elements = [];
    h.eq(deckSchemaFor(d), "0.6.0", "removing it lowers the stamp again");
    // The stamp table without the stage-2 image detectors is exactly the table this build had before stage 2 (attach /
    // radial at 0.7.0): a deck without an image stamps the same under both, so its bytes cannot change. (W8 added two more
    // image features at 0.8.0: a stagger ordered by a table column and the Become pair "key"; a deck holds them only for
    // an image's objects, and they register at the image version.)
    const STAGE2 = new Set(["fluximg", "objectStagger", "pairKey"]);
    h.ok(DECK_FEATURES.filter((f) => STAGE2.has(f.name)).every((f) => f.version === "0.8.0"), "every stage-2 image feature stamps 0.8.0");
    const before = DECK_FEATURES.filter((f) => !STAGE2.has(f.name));
    h.eq(before.map((f) => `${f.name}@${f.version}`), ["attach@0.7.0", "radial@0.7.0"], "the pre-stage-2 feature table, unchanged");

    // decks without images, written by flux-core, re-saved by both engines
    const plain = await core.createDeck(root, { id: "plain", title: "Plain" });
    await slidesCore.mutateDeck(root, "plain", "test_text", (deck) => { slideOps.addSlideText(deck, deck.slides[0].id, { text: "hello", x: 20, y: 20 }); });
    const radial = await core.createDeck(root, { id: "radial", title: "Radial" });
    const rd = await slidesCore.loadDeck(root, "radial");
    await slidesCore.mutateDeck(root, "radial", "test_radial", (deck) => {
      const s = deck.slides[0], t = slideOps.addSlideText(deck, s.id, { text: "x", x: 1, y: 1 })!;
      const b = slideOps.addBeat(deck, s.id, {})!;
      slideOps.setAnimation(deck, s.id, b.id, { target: t, preset: "fade", start: 0, duration: 300, stagger: { totalMs: 600, by: "radial" } } as never);
    });
    void plain; void rd; void radial;
    for (const [id, want] of [["plain", "0.6.0"], ["radial", "0.7.0"]] as const) {
      const first = await fs.readFile(deckFile(id), "utf8"), deck = await slidesCore.loadDeck(root, id);
      h.ok(JSON.parse(first).schemaVersion === want && deckSchemaFor(deck) === deckSchemaFor(deck, before), `${id}: written as ${want}, the same stamp as before stage 2`);
      await slidesCore.saveDeck(root, deck);
      h.ok(await fs.readFile(deckFile(id), "utf8") === first, `${id}: flux-core load + save is byte-identical`);
      h.ok(await appSave(await slidesCore.loadDeck(root, id), await diskFiles(id)) === first, `${id}: the app's fold + write point gives the same bytes`);
    }
    // an older reader (read format 0.7.0, editable 0.2-0.7) meets a 0.8.0 deck: its forward guard runs first
    const oldEditable = /^0\.[234567]\./;
    h.ok(isNewerSchema("0.8.0", "0.7.0") && !oldEditable.test("0.8.0") && DECK_EDITABLE.test("0.8.0"), "0.8.0 is NEWER to a 0.7 build, editable to this one");
    const msg = newerSchemaMessage("slides/talk/deck.json", "0.8.0", "0.7.0");
    h.ok(/written by a newer Flux/.test(msg) && !/invalid/i.test(msg), `an older build refuses with the forward-version message: "${msg.slice(0, 70)}…"`);
    // the same guard in this build, one minor up, before any validation (the deck is otherwise garbage)
    await fs.mkdir(path.join(root, "slides", "future"), { recursive: true });
    await fs.writeFile(deckFile("future"), JSON.stringify({ schemaVersion: "0.9.0", id: "future", slides: "not even an array" }));
    const m = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8")); m.slides = [...(m.slides ?? []), { id: "future", path: "slides/future/deck.json" }];
    await fs.writeFile(path.join(root, "project.json"), JSON.stringify(m, null, 2));
    const refused = await slidesCore.loadDeck(root, "future").then(() => "", (e: Error) => e.message);
    h.ok(/written by a newer Flux/.test(refused), `the forward guard runs before validation ("${refused.slice(0, 60)}…")`);
    m.slides = m.slides.filter((s: { id: string }) => s.id !== "future"); await fs.writeFile(path.join(root, "project.json"), JSON.stringify(m, null, 2));
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("C. fold / unfold");
  {
    const d = slideOps.createDeck({ id: "fold", title: "F" });
    const el = image({ view: { index: { z: 2 }, layers: {} as never }, crop: { x: 1, y: 2, width: 30, height: 20 } });
    delete (el.view as Record<string, unknown>).layers;
    d.slides[0].elements.push(el);
    const assets: Asset[] = [{ id: "img-a", name: "a", kind: "fluximg", path: "assets/img-a.fluximg", naturalWidth: 64, naturalHeight: 48 } as Asset];
    const back = projectIntoDeck(deckToProject(d, assets), d, { externalAssetIds: new Set() });
    h.eq(back.slides[0].elements, d.slides[0].elements, "the element, its view and its crop survive the fold exactly");
    h.ok(!back.assets.length, "an image asset in the projection (even one not marked external) never folds into deck.assets");
    h.ok(slideAssetIds(d.slides[0]).has("img-a"), "slideAssetIds names the image's asset (dependencies, presets)");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("D. headless: place-image on a slide, set-image-view on Design and at a step, image-info");
  await core.createDeck(root, { id: "talk", title: "Talk" });
  const talk0 = await slidesCore.loadDeck(root, "talk");
  const slideId = talk0.slides[0].id;
  const beats: string[] = [];
  for (let i = 0; i < 3; i++) beats.push((await slidesCore.addBeat(root, "talk", slideId, {})).beatId);
  const dirs = async () => (await fs.readdir(path.join(root, "fig/assets")).catch(() => [])).filter((n) => n.endsWith(".fluximg"));
  const placed = await call("place_image", { figureId: `talk/${slideId}`, bundlePath: "plots/stack_u16.fluximg", name: "Stack" });
  let talk = await readDeck("talk");
  const placedEl = talk.slides[0].elements.find((e) => e.id === placed.elementId) as FluximgElement;
  h.ok(placed.deckId === "talk" && placed.slideId === slideId && placedEl?.type === "fluximg" && placedEl.name === "Stack", "place-image deckId/slideId adds the image to the slide");
  h.ok(talk.schemaVersion === "0.8.0" && !talk.assets.length && (await dirs()).includes(`${placed.assetId}.fluximg`), "the deck is written as 0.8.0, owns no asset; the bundle is in fig/assets");
  h.ok(placedEl.width === 64 && placedEl.height === 48 && placedEl.source?.bundlePath === "plots/stack_u16.fluximg", "1 image px per stage px; the source record as on a figure");
  const second = await call("place_image", { figureId: slideId, bundlePath: "plots/stack_u16.fluximg", x: 300, y: 10 });
  h.ok(second.slideId === slideId && (await dirs()).filter((n) => n.startsWith("img-stack")).length >= 1, "a bare slide id works too");
  const { loadFigModel } = await import("../flux-core/model");
  const figAssets = (await loadFigModel(root)).project.assets;
  h.ok(!figAssets.some((a) => a.id === placed.assetId), "the figure index is not written (a deck refers to the bundle by its folder)");
  const resolved = fluximgResolvedAsset(placed.assetId, stackManifest, placedEl.source?.sha256);
  h.ok(resolved.path === `assets/${placed.assetId}.fluximg` && resolved.naturalWidth === 64 && resolved.sha256 === placedEl.source?.sha256 && resolved.fluximg?.dims.join() === "c,z,y,x", "the rebuilt record: path, size, content id, digest");
  await refuses("set_image_view", { id: placed.elementId, view: { index: { z: 1 } }, beatId: beats[0] }, /--beat needs the slide/, "--beat without --slide is refused");
  await refuses("set_image_view", { id: placed.elementId, view: { index: { z: 1 } }, slide: `talk/${slideId}`, beatId: talk.slides[0].beats[0].id }, /after Design/, "--beat on Design is refused");
  await refuses("set_image_view", { id: placed.elementId, view: { index: { z: 99 } }, slide: `talk/${slideId}` }, /does not fit|out of range|z/, "a view that does not fit the image is refused");

  // Design: z 1. Link the two panels (Design) so a step edit of one moves the other at the same step.
  await call("set_image_view", { id: placed.elementId, view: { index: { z: 1 }, link: "pair" }, slide: `talk/${slideId}` });
  await call("set_image_view", { id: second.elementId, view: { link: "pair" }, slide: `talk/${slideId}` });
  talk = await readDeck("talk");
  h.eq((talk.slides[0].elements.find((e) => e.id === placed.elementId) as FluximgElement).view, { index: { z: 1 }, link: "pair" }, "set-image-view --slide (no --beat) edits the Design view");
  // step 1: walk the planes to z 5; step 2: zoom (crop); step 3: contrast
  const s1 = await call("set_image_view", { id: placed.elementId, view: { index: { z: 5 } }, slide: `talk/${slideId}`, beatId: beats[0] });
  const s2 = await call("set_image_view", { id: placed.elementId, crop: { x: 16, y: 12, width: 32, height: 24 }, slide: `talk/${slideId}`, beatId: beats[1] });
  const s3 = await call("set_image_view", { id: placed.elementId, view: { channels: [{ range: [100, 20000] }] }, slide: `talk/${slideId}`, beatId: beats[2] });
  talk = await readDeck("talk");
  const slide = talk.slides[0];
  const changeOf = (bi: number, target: string) => slide.beats[bi].tracks.filter((t) => t.preset === "transform" && t.target === target);
  const c1 = changeOf(1, placed.elementId), c2 = changeOf(2, placed.elementId), c3 = changeOf(3, placed.elementId);
  h.ok(c1.length === 1 && c2.length === 1 && c3.length === 1 && s1.trackIds.includes(c1[0].id) && s3.trackIds.includes(c3[0].id), "each --beat edit is ONE Change on its step");
  // B2 (supersedes plan D1's "whole"): a step's view is the PATCH over the view before the step, so Design's link is not restated
  h.eq((c1[0].to!.state as Record<string, unknown>).view, { index: { z: 5 } }, "step 1's to.state.view is the patch over the view before the step (Design's link is not frozen into it)");
  h.ok(Object.keys(c1[0].to!.state!).join() === "view", `step 1 changes nothing else (${Object.keys(c1[0].to!.state!).join()})`);
  const st2 = c2[0].to!.state as Record<string, unknown>;
  h.eq(st2.crop, { x: 16, y: 12, width: 32, height: 24 }, "step 2's to.state.crop is the end's crop");
  h.ok(!("view" in st2) && !("assetId" in st2) && !("source" in st2), "…and carries no view, assetId or source");
  h.eq(((c3[0].to!.state as { view: FluximgElement["view"] }).view?.channels?.[0] as { range?: number[] })?.range, [100, 20000], "step 3's view carries the new window");
  h.eq((slide.elements.find((e) => e.id === placed.elementId) as FluximgElement).view, { index: { z: 1 }, link: "pair" }, "Design is untouched by the step edits");
  const linked = changeOf(1, second.elementId);
  h.ok(linked.length === 1 && ((linked[0].to!.state as { view?: FluximgElement["view"] }).view?.index?.z === 5) && changeOf(2, second.elementId).length === 0,
    "a linked panel on the same slide follows at the same step (the shared part: the plane), not the crop");
  h.ok(s2.trackIds.length === 1, "a crop step writes only the edited image (crops are not shared)");
  const info = await call("image_info", { target: placed.elementId });
  h.ok(info.assetId === placed.assetId && info.element?.elementId === placed.elementId && info.placements.some((p: { slideId?: string }) => p.slideId === slideId) && info.width === 64, "image-info describes an element on a slide (its Design state) and lists slide placements");
  const byAsset = await call("image_info", { target: placed.assetId });
  h.ok(byAsset.placements.length >= 2 && !byAsset.issue, "image-info by asset id finds a slide-only asset");

  {
    const { figureId } = await core.createFigure(root, { id: "fig-s", name: "S", width: 400, height: 300 });
    const onFig = await call("place_image", { figureId, bundlePath: "plots/stack_u16.fluximg" });
    const reg = (await loadFigModel(root)).project.assets.find((a) => a.id === onFig.assetId);
    h.ok(onFig.reused && onFig.assetId === placed.assetId && reg?.bytes! > 0 && reg?.sha256 === placedEl.source?.sha256, "a figure placement of a bundle already on a slide reuses that asset, with a complete record in the figure index");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("E. the tween across three steps");
  {
    const compiled = await slidesCore.compileDeckSlide(root, talk, slideId);
    const design = slide.elements.find((e) => e.id === placed.elementId) as FluximgElement;
    let pre: Element = design;
    for (let bi = 1; bi <= 3; bi++) {
      const p = transformPreState(slide, placed.elementId, bi) as FluximgElement;
      h.eq({ view: p.view, crop: p.crop }, { view: (pre as FluximgElement).view, crop: (pre as FluximgElement).crop }, `transformPreState(step ${bi}) folds every earlier Change`);
      const end = transformEndState(p, changeOf(bi, placed.elementId)[0]) as FluximgElement;
      const at = compiled.sample(bi).elements.find((e) => e.id === placed.elementId) as FluximgElement;
      h.eq({ view: at.view, crop: at.crop }, { view: end.view, crop: end.crop }, `compile.sample(${bi}) at rest is exactly transformEndState`);
      h.eq(at.view, applyState(p, changeOf(bi, placed.elementId)[0].to!.state!).view ?? undefined, `…which is applyState(pre, to.state) (step ${bi})`);
      pre = end;
    }
    // mid-flight: a valid recipe of THIS image (depends on W1a's lerpFluximgView: whole planes, numbers in range)
    const duration = compiled.cues[1].duration;
    const planes = new Set<number>();
    let valid = true;
    for (let i = 1; i < 20; i++) {
      const mid = compiled.sample(1, (duration * i) / 20).elements.find((e) => e.id === placed.elementId) as FluximgElement;
      const z = mid.view?.index?.z;
      if (typeof z === "number") planes.add(z);
      const problems = checkViewPatch(stackManifest, mid.view ?? {}).problems;
      if (problems.length || !(Number.isInteger(z) && z! >= 0 && z! < nz)) { valid = false; h.fail(`mid-flight sample ${i}/20 is not a valid recipe: ${problems.join("; ")} z=${z}`); break; }
    }
    h.ok(valid, "every mid-flight sample of step 1 is a valid view of the image (whole planes, in range) [W1a]");
    h.ok([...planes].every((z) => z >= 1 && z <= 5) && planes.size >= 3, `step 1 walks the planes between its ends (${[...planes].sort().join(",")}) [W1a]`);
    // step 2's crop is one-sided (absent before = the whole image). C1: the sample is the player's own frame, so it GLIDES
    // from the whole image to the end's crop (it stepped at raw 0.5 while compile.sample had its own recipe)
    const crop2 = (frac: number) => (compiled.sample(2, compiled.cues[2].duration * frac).elements.find((e) => e.id === placed.elementId) as FluximgElement).crop;
    const w2 = crop2(0.2)?.width ?? 0, w5 = crop2(0.5)?.width ?? 0, w9 = crop2(0.9)?.width ?? 0;
    h.ok(w2 < 64 && w2 > w5 && w5 > w9 && w9 > 32, `a one-sided crop glides from the whole image to the end's crop, as the player draws it (widths ${[w2, w5, w9].map((w) => w.toFixed(2)).join(" > ")})`);
    // lerpElement dispatches `view` on the kind: a plot view is still the plot law
    const plotA = { type: "plot", id: "p", assetId: "a", x: 0, y: 0, width: 10, height: 10, rotation: 0, view: { x: { domain: [0, 10] } } } as unknown as Element;
    const plotB = { ...plotA, view: { x: { domain: [10, 20] } } } as unknown as Element;
    h.eq((lerpElement(plotA, plotB, 0.5, 0.5) as unknown as { view: { x: { domain: number[] } } }).view?.x?.domain, [5, 15], "a plot's view still lerps its axis domain (lerpView)");
    const imgA = image({ view: { channels: [{ range: [0, 100] }] } }), imgB = image({ view: { channels: [{ range: [100, 300] }] } });
    const half = lerpElement(imgA, imgB, 0.5, 0.5) as FluximgElement;
    h.eq((half.view?.channels?.[0] as { range?: number[] })?.range, [50, 200], "an image's view dispatches to lerpFluximgView (a window lerps) [W1a]");
    h.eq((lerpElement(imgA, imgB, 1, 1) as FluximgElement).view, imgB.view, "the end is exact");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("F. diagnostics");
  {
    const d = slideOps.createDeck({ id: "diag", title: "D" });
    const s = d.slides[0], b = slideOps.addBeat(d, s.id, {})!;
    s.elements.push(image({ view: { index: { z: 3 } } }));
    slideOps.setTransform(d, s.id, b.id, "img", { state: { view: { index: { z: 40 } } } });
    const manifest = (id: string) => (id === "img-a" ? stackManifest : undefined);
    const issues = compileSlide(s, d.stage, { fluximgManifest: manifest }).issues.map((i) => i.reason);
    h.ok(issues.some((r) => /This Change's image view does not fit the image/.test(r)), `a Change view out of range is reported (${issues.find((r) => /Change's image/.test(r))?.slice(0, 80)})`);
    s.elements[0] = image({ view: { index: { q: 1 } as never } });
    h.ok(compileSlide(s, d.stage, { fluximgManifest: manifest }).issues.some((i) => /The image's view does not fit/.test(i.reason)), "a Design view that does not fit is reported");
    h.ok(compileSlide(s, d.stage, { fluximgIssue: () => "fig/assets/img-a.fluximg is missing" }).issues.some((i) => /bundle cannot be shown: fig\/assets/.test(i.reason)), "a missing bundle is reported");
    h.eq(compileSlide(s, d.stage, {}).issues.filter((i) => /image/i.test(i.reason)), [], "without lookups (no manifest known) nothing is checked");
    let asked = 0;
    const plain = slideOps.createDeck({ id: "p", title: "P" });
    slideOps.addSlideText(plain, plain.slides[0].id, { text: "t", x: 0, y: 0 });
    compileSlide(plain.slides[0], plain.stage, { fluximgManifest: () => { asked++; return undefined; }, fluximgIssue: () => { asked++; return undefined; } });
    h.eq(asked, 0, "a slide without images never asks the image lookups");
    const live = await slidesCore.compileDeckSlide(root, talk, slideId);
    h.eq(live.issues.filter((i) => /image/i.test(i.reason)), [], "flux-core's compile options read each image's manifest: the authored deck has no image issue");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("G. capture law and Become rules");
  {
    const pre = image({ view: { index: { z: 1 } } });
    const cur = { ...structuredClone(pre), assetId: "other", source: { bundlePath: "plots/x.fluximg" }, playback: { dim: "t", mode: "loop" }, view: { index: { z: 2 } }, crop: { x: 0, y: 0, width: 8, height: 8 } } as unknown as Element;
    h.eq(diffState(pre, cur), { view: { index: { z: 2 } }, crop: { x: 0, y: 0, width: 8, height: 8 } }, "assetId, source and playback are never a step's state; view (a patch over the view before the step) and crop (whole) are");
    const d = slideOps.createDeck({ id: "g", title: "G" });
    const s = d.slides[0], b = slideOps.addBeat(d, s.id, {})!;
    s.elements.push(image());
    const edited = { ...image(), view: { index: { z: 4 } } } as Element;
    const base = s.elements.find((e) => e.id === "img")!;
    const t = slideOps.writeStepState(d, s.id, b.id, edited, base);
    h.ok(!!t && (t.to!.state as { view: unknown }).view !== undefined && Object.keys(t.to!.state!).join() === "view", "writeStepState writes the diff against the pre-state as the step's Change");
    slideOps.writeStepState(d, s.id, b.id, { ...image(), view: { index: { z: 6 } } } as Element, base);
    h.eq(s.beats[1].tracks.length, 1, "…and a second edit at the same step replaces that Change's state (one Change per step)");
    // Become
    const bd = slideOps.createDeck({ id: "b", title: "B" });
    const bs = bd.slides[0], bb = slideOps.addBeat(bd, bs.id, {})!;
    const rect = slideOps.addSlideText(bd, bs.id, { text: "label", x: 300, y: 10 })!;
    bs.elements.push(image({ id: "imgA" }), image({ id: "imgB", assetId: "img-b", x: 200 }), image({ id: "imgA2", x: 400 }));
    const into = slideOps.becomeTransform(bd, bs.id, bb.id, rect, "imgA");
    const track = bs.beats[1].tracks.find((x) => x.id === into?.trackId);
    h.ok(track?.to?.become?.mode === "handoff", "a Become into an image is a hand-off by default (as for a raster image)");
    const refuse = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };
    h.ok(/cannot turn into an image in place/.test(refuse(() => slideOps.becomeTransform(bd, bs.id, bb.id, rect, "imgA", { mode: "consume" }))), "a consume into an image is refused with its reason");
    h.ok(/cannot become another image yet/.test(refuse(() => slideOps.becomeTransform(bd, bs.id, bb.id, "imgA", "imgB"))), "an image becoming another image's bundle is refused with its reason");
    const same = slideOps.becomeTransform(bd, bs.id, bb.id, "imgA", "imgA2");
    h.ok(!!same?.trackId, "two placements of the same image may hand off (box flight + crossfade)");
    // a hand-off written by hand between two bundles is reported by the compiler
    slideOps.setAnimation(bd, bs.id, bb.id, { id: "manual", target: "imgB", preset: "transform", to: { become: { ref: { element: "imgA2" }, mode: "handoff" }, state: {} } } as never);
    h.ok(compileSlide(bs, bd.stage).issues.some((i) => i.trackId === "manual" && /cannot become another image yet/.test(i.reason)), "the compiler reports an image → other image hand-off written by hand");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("H. Send figure to deck; saved slide presets");
  {
    const d = slideOps.createDeck({ id: "send", title: "Send" });
    const ids = slideOps.addFigureContentToSlide(d, d.slides[0].id, { elements: [image({ view: { index: { z: 2 } }, crop: { x: 0, y: 0, width: 10, height: 10 } })] });
    const copy = d.slides[0].elements.find((e) => e.id === ids[0]) as FluximgElement;
    h.ok(copy?.type === "fluximg" && copy.assetId === "img-a" && copy.view?.index?.z === 2 && copy.crop?.width === 10 && !d.assets.length, "Send figure to deck copies the image (view, crop) by id; the deck owns no asset");
    const p = deckToProject(d, []);
    const big: Asset = { id: "big", name: "big", kind: "fluximg", path: "assets/big.fluximg", naturalWidth: 4000, naturalHeight: 3000 } as Asset;
    const bid = ops.addFluximg(p, { figureId: d.slides[0].id, asset: big });
    const bigEl = p.figures[0].elements.find((e) => e.id === bid)!;
    h.ok(bigEl.width <= d.stage.width && bigEl.height <= d.stage.height && Math.abs(bigEl.width / bigEl.height - 4 / 3) < 1e-9, `a large image fits the stage on both axes, aspect kept (${bigEl.width.toFixed(1)}×${bigEl.height.toFixed(1)})`);
    const tall: Asset = { ...big, id: "tall", naturalWidth: 300, naturalHeight: 2000 } as Asset;
    const tid = ops.addFluximg(p, { figureId: d.slides[0].id, asset: tall });
    const tallEl = p.figures[0].elements.find((e) => e.id === tid)!;
    h.ok(tallEl.height <= d.stage.height && tallEl.width < 300, `an image taller than the stage (narrower than it) fits its height (${tallEl.width.toFixed(1)}×${tallEl.height.toFixed(1)})`);
    // linked panels on a slide never write into another slide
    const two = slideOps.createDeck({ id: "two", title: "Two" });
    slideOps.addSlide(two, {});
    two.slides[0].elements.push(image({ id: "a1", view: { link: "L" } }));
    two.slides[1].elements.push(image({ id: "a2", view: { link: "L" } }));
    const proj = deckToProject(two, []);
    ops.setFluximgView(proj, "a1", { index: { z: 3 } });
    h.ok(proj.figures[1].elements[0].type === "fluximg" && !(proj.figures[1].elements[0] as FluximgElement).view?.index, "on a deck canvas a linked view stays inside its slide");

    // saved preset: an image's bundle is never embedded; it is reported, and the element is kept
    let saved: any = null;
    (globalThis as any).window = { fig: { writeSlideLibrary: async (_rel: string, snap: unknown) => { saved = snap; return true; } } };
    const { saveSlidePreset } = await import("../src/lib/slide/presetLib");
    const { loadDeckModel, currentDeck } = await import("../src/lib/slide/store");
    const currentDeckNow = () => currentDeck()!;
    const { setStoreTenant } = await import("../src/lib/tenancy");
    const { embeddedProjectRoot } = await import("../src/lib/store");
    setStoreTenant("slide"); embeddedProjectRoot.set(root);
    const pd = slideOps.createDeck({ id: "preset", title: "Preset" });
    pd.slides[0].elements.push(image());
    loadDeckModel(pd, [{ id: "img-a", name: "a", kind: "fluximg", path: "assets/img-a.fluximg", naturalWidth: 64, naturalHeight: 48 } as Asset], new Set(["img-a"]));
    const res = await saveSlidePreset("with image", pd.slides[0].id);
    h.ok(!!res && res.missingAssets.includes("img-a") && !!saved && !(saved.assets ?? []).some((a: { asset: Asset }) => a.asset.kind === "fluximg") && saved.slide.elements.some((e: Element) => e.type === "fluximg"),
      "a saved preset keeps the image element, embeds no bundle and reports the asset as not embedded");
    // C5: stamped with the content-derived minimum, so a build that would drop the image never lists it
    const { slidePresetEntries, insertSlidePreset, slidePresetStamp } = await import("../src/lib/slide/presetLib");
    h.ok(saved.fluxPreset === 2 && saved.schemaVersion === "0.8.0", `a preset holding an image is stamped fluxPreset 2, format ${saved.schemaVersion} (deckSchemaFor over its slide)`);
    const oldReader = (p: { fluxPreset?: unknown; kind?: unknown }) => p.fluxPreset === 1 && p.kind === "slide"; // every released build's filter
    h.ok(!oldReader(saved), "…which every older build's preset filter skips: it is never inserted there with the image dropped");
    h.eq(slidePresetStamp(slideOps.createDeck({ id: "p", title: "P" }).slides[0]), { fluxPreset: 1 }, "a slide without an image stays fluxPreset 1 with no stamp (its file as before)");
    const listed = slidePresetEntries([{ rel: "a.json", payload: saved }, { rel: "b.json", payload: { ...saved, schemaVersion: "0.9.0" } }, { rel: "c.json", payload: { ...saved, fluxPreset: 3 } }]);
    h.ok(!listed[0].refusal && /written by a newer Flux/.test(listed[1].refusal ?? "") && /written by a newer Flux/.test(listed[2].refusal ?? ""), `a preset of a newer format or version is listed with the "newer Flux" words: "${listed[1].refusal}"`);
    let why = "";
    try { await insertSlidePreset(listed[1]); } catch (e) { why = (e as Error).message; }
    h.ok(/newer Flux/.test(why), "…and inserting it is refused with them");
    // survives save → insert in this build (the bundle is registered here)
    const n0 = currentDeckNow().slides.length;
    const nid = await insertSlidePreset(listed[0]);
    const ins = currentDeckNow().slides.find((x) => x.id === nid);
    h.ok(!!nid && currentDeckNow().slides.length === n0 + 1 && ins!.elements.some((e) => e.type === "fluximg" && e.assetId === "img-a"), "the preset inserts into this project with its image");
    // another project, where the bundle does not exist: a refusal naming the image, not a grey box
    const other = path.join(scratch, "other");
    await core.scaffold(other, { title: "other" });
    (globalThis as any).window.fig = { ...(globalThis as any).window.fig, readText: async (p: string) => fs.readFile(p, "utf8"), exists: async (p: string) => fs.stat(p).then(() => true, () => false) };
    embeddedProjectRoot.set(other);
    const od = slideOps.createDeck({ id: "od", title: "Other" });
    loadDeckModel(od, [], new Set());
    why = "";
    try { await insertSlidePreset({ ...listed[0], preset: { ...listed[0].preset, slide: { ...listed[0].preset.slide, elements: listed[0].preset.slide.elements.map((e) => (e.type === "fluximg" ? { ...e, name: "Stack A" } : e)) } } }); } catch (e) { why = (e as Error).message; }
    h.ok(/"Stack A".*not in this project/.test(why) && currentDeckNow().slides.length === 1, `inserting it in another project is refused, naming the image: "${why}"`);
    // …and where the bundle IS in that project's fig/assets but not loaded yet, it is registered with the insert
    await writeFixture(path.join(other, "fig/assets"), fx["gray2d_u8"]);
    const there = { ...listed[0], preset: { ...listed[0].preset, slide: { ...listed[0].preset.slide, elements: listed[0].preset.slide.elements.map((e) => (e.type === "fluximg" ? { ...e, assetId: "gray2d_u8" } : e)) } } };
    const nid2 = await insertSlidePreset(there);
    const { project: figProject } = await import("../src/lib/store");
    const { get: getStore } = await import("svelte/store");
    h.ok(!!nid2 && currentDeckNow().slides.find((x) => x.id === nid2)!.elements.some((e) => e.type === "fluximg" && e.assetId === "gray2d_u8")
      && getStore(figProject).assets.some((a: Asset) => a.id === "gray2d_u8" && a.kind === "fluximg"), "a bundle present in the project's fig/assets is registered with the insert");
    setStoreTenant("figure");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("I. a step's view is a patch over the view before it: Design edits carry through (B2)");
  {
    const { resolveView } = await import("../src/lib/fluximg/viewOps");
    await core.createDeck(root, { id: "patch", title: "Patch" });
    const sid = (await slidesCore.loadDeck(root, "patch")).slides[0].id;
    const pb: string[] = [];
    for (let i = 0; i < 3; i++) pb.push((await slidesCore.addBeat(root, "patch", sid, {})).beatId);
    const mv = await call("place_image", { figureId: `patch/${sid}`, bundlePath: "plots/movie_f32.fluximg", name: "Movie" });
    const movieManifest = JSON.parse(await fs.readFile(path.join(root, "plots/movie_f32.fluximg/fluximg.json"), "utf8")) as FluximgManifest;
    const start = structuredClone(await readDeck("patch"));
    // The edits, in the order the owner makes them: step 1 walks t and sets a window; Design then changes channel 1's colour.
    const edits: Array<{ beat?: number; view: Record<string, unknown> }> = [
      { beat: 1, view: { index: { t: 8 }, channels: [{ range: [0, 500] }] } },
      { view: { channels: [{ color: "#00ffff" }] } },
    ];
    const apply = async (e: { beat?: number; view: Record<string, unknown> }) =>
      call("set_image_view", { id: mv.elementId, view: e.view, slide: `patch/${sid}`, ...(e.beat ? { beatId: pb[e.beat - 1] } : {}) });
    for (const e of edits) await apply(e);
    let deck = await readDeck("patch");
    const at = async (bi: number) => {
      const c = await slidesCore.compileDeckSlide(root, deck, sid);
      return resolveView(movieManifest, (c.sample(bi).elements.find((e) => e.id === mv.elementId) as FluximgElement).view);
    };
    const s1 = await at(1);
    h.ok(s1.index.t === 8 && JSON.stringify(s1.channels[0].range) === "[0,500]" && s1.channels[0].color === "#00ffff",
      `the review's repro: step 1 shows the walk (t ${s1.index.t}), the window (${JSON.stringify(s1.channels[0].range)}) AND the new Design colour (${s1.channels[0].color})`);
    const s3 = await at(3);
    h.ok(s3.channels[0].color === "#00ffff" && s3.index.t === 8, "…and so do the later steps (step 3: the colour, and step 1's walk held)");
    h.eq((deck.slides[0].beats[1].tracks.find((t) => t.target === mv.elementId)!.to!.state as { view: unknown }).view, { index: { t: 8 }, channels: [{ range: [0, 500] }] },
      "the step stores only what it changes (the patch), never the Design colour");
    // A Design edit of something the step DOES change does not leak into the step.
    edits.push({ view: { index: { t: 3 }, channels: [{ range: [0, 1000] }] } });
    await apply(edits[edits.length - 1]);
    deck = await readDeck("patch");
    const d0 = await at(0), d1 = await at(1);
    h.ok(d0.index.t === 3 && d1.index.t === 8 && JSON.stringify(d1.channels[0].range) === "[0,500]" && JSON.stringify(d0.channels[0].range) === "[0,1000]",
      "a Design edit of what the step changes (the plane, the window) moves Design only: step 1 still shows t 8 and [0,500]");
    // A step that CLEARS a setting holds: projection off at step 2 while Design has it on.
    edits.push({ view: { projection: { dim: "t", mode: "max", from: 0, to: 24 } } });
    await apply(edits[edits.length - 1]);
    edits.push({ beat: 2, view: { projection: null } });
    await apply(edits[edits.length - 1]);
    deck = await readDeck("patch");
    const p0 = await at(0), p1 = await at(1), p2 = await at(2), p3 = await at(3);
    h.ok(!!p0.projection && !!p1.projection && p2.projection === null && p3.projection === null,
      `a step that clears a setting holds: projection on in Design and step 1, off at step 2 and after (${[p0, p1, p2, p3].map((v) => v.projection ? "on" : "off").join(", ")})`);
    h.eq((deck.slides[0].beats[2].tracks.find((t) => t.target === mv.elementId)!.to!.state as { view: unknown }).view, { projection: null }, "…stored as the patch {projection: null}");

    // Twin engines: the app's capture (the store's adapter: the edited end through ops.setFluximgView, then
    // slideOps.writeStepState against compile.preState) gives the same deck bytes as the headless verb.
    const app = structuredClone(start);
    const appSlide = app.slides[0];
    const imgOf = (els: Element[]) => els.find((e) => e.id === mv.elementId) as FluximgElement;
    for (const e of edits) {
      if (!e.beat) { const proj = deckToProject(app, []); ops.setFluximgView(proj, mv.elementId, e.view as never); appSlide.elements = proj.figures[0].elements; continue; }
      const compiled = compileSlide(appSlide, app.stage, { fluximgManifest: () => movieManifest });
      const ends = structuredClone(compiled.sample(e.beat).elements);
      const proj = { ...deckToProject(app, []) };
      proj.figures = [{ ...proj.figures[0], elements: ends }];
      ops.setFluximgView(proj, mv.elementId, e.view as never);
      slideOps.writeStepState(app, appSlide.id, appSlide.beats[e.beat].id, imgOf(proj.figures[0].elements), compiled.preState(mv.elementId, e.beat) ?? imgOf(appSlide.elements), { fluximgManifest: () => movieManifest });
    }
    const norm = (d: Deck) => JSON.stringify(d.slides[0].beats.map((b) => b.tracks.map(({ id: _id, ...t }) => t))) + JSON.stringify(imgOf(d.slides[0].elements));
    h.eq(norm(app), norm(deck), "twin engines: the app's capture path and the headless verb write the same Changes and the same Design element");
  }

  // ----------------------------------------------------------------------------------------------------------------
  h.section("J. headless delete-element on a slide (C6)");
  {
    await core.createDeck(root, { id: "del", title: "Del" });
    const sid = (await slidesCore.loadDeck(root, "del")).slides[0].id;
    const b1 = (await slidesCore.addBeat(root, "del", sid, {})).beatId;
    const a = await call("place_image", { figureId: `del/${sid}`, bundlePath: "plots/stack_u16.fluximg" });
    const keep = await call("place_image", { figureId: `del/${sid}`, bundlePath: "plots/gray2d_u8.fluximg", x: 300 });
    await call("set_image_view", { id: a.elementId, view: { index: { z: 5 } }, slide: `del/${sid}`, beatId: b1 });
    // a group of the two and a Ghost birth from the kept image (its copies are born at step 1)
    await slidesCore.mutateDeck(root, "del", "prep", (d) => {
      const s = d.slides[0];
      const beats = s.beats; delete (s as Partial<typeof s>).beats; // the app's key order: groups after the elements
      s.groups = { g1: { name: "Pair" } } as never; s.beats = beats;
      for (const e of s.elements) e.groupId = "g1";
      slideOps.addGhostTransform(d, s.id, b1, keep.elementId, { count: 1 });
    });
    const before = await readDeck("del");
    const ghostId = before.slides[0].beats[1].tracks.find((t) => t.ghostFrom)!.target;
    const r = await call("delete_elements", { ids: [a.elementId, ghostId] });
    const after = await readDeck("del");
    h.eq(r.deleted, [a.elementId, ghostId], "delete-element finds elements on a slide and says what it deleted");
    h.ok(!after.slides[0].elements.some((e) => e.id === a.elementId || e.id === ghostId), "the image and the Ghost copy are gone from the slide");
    h.ok(!after.slides[0].beats.some((b) => b.tracks.some((t) => t.ghostFrom && t.target === ghostId)), "the Ghost copy's birth goes with it");
    h.ok(after.slides[0].beats[1].tracks.some((t) => t.target === a.elementId && t.preset === "transform"), "the image's own Change stays, as in the editor (dangling tracks are never auto-pruned)");
    // the app's engine: the figure store's Delete (ops.deleteElements over the projected slide) folded back, plus the adapter's birth rule
    const app = structuredClone(before);
    const proj = deckToProject(app, app.assets);
    ops.deleteElements(proj, [a.elementId, ghostId]);
    const folded = projectIntoDeck(proj, app);
    const gone = new Set([a.elementId, ghostId]);
    slideOps.removeTracks(folded, sid, slideOps.orphanedBirths(folded.slides[0], gone));
    const clock = (t: string) => t.replace(/"modified": "[^"]*"/, '"modified": ""'); // each write point stamps its own clock
    const appText = clock(await appSave(folded, await diskFiles("del")));
    h.ok(appText === clock(await fs.readFile(deckFile("del"), "utf8")), "twin engines: the editor's Delete (folded and written by the app's write point) and the headless delete give the same deck bytes");
    await refuses("delete_elements", { ids: ["no-such-element"] }, /No element "no-such-element" in any figure or slide/, "an id found nowhere is an error, never a false \"deleted\"");
    const { figureId } = await core.createFigure(root, { id: "fig-del", name: "D", width: 200, height: 100 });
    const onFig = await call("place_image", { figureId, bundlePath: "plots/gray2d_u8.fluximg" });
    const r2 = await call("delete_elements", { ids: [onFig.elementId] });
    h.eq(r2.deleted, [onFig.elementId], "a figure element is still deleted through the figure core");
  }
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
await h.done();
