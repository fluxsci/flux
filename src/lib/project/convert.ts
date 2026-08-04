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
import type { Figure, Project as FigProject, Asset } from "../types";
import type { Deck, Slide } from "../slide/types";
import * as ops from "../ops";
import * as slideOps from "../slide/ops";
import { readDeck, writeDeckDirect, listProjectDecks } from "./slideBridge";
import { createDeck as createDeckModel } from "../slide/ops";
import { cloneContentWithFreshIds } from "../slide/deckProject";
import { fileBridge, joinPath } from "./types";
import {
  planFigSave,
  executeFigSave,
  sortedCanvasMeta,
  normalizeIndexAssets,
  type FigIndexFile,
  type CanvasFile,
  type FigSaveIO,
} from "./figfiles";
import { familyHintsFrom, migrateFigureFamilies, migrateProject } from "../migrate";
import { project as figProject } from "../store";
import { getAssetData } from "../assets";
import { dataUrlToBytes } from "../assets";
import { plotManifests } from "../plot/store";
import { isDerivedManifest } from "../plot/derive";
import { newId } from "../ids";

export { listProjectDecks };

/** The project's fig/ canvases (id + name), for the Send-to-canvas picker. */
export async function listFigCanvases(root: string): Promise<{ id: string; name: string }[]> {
  const fig = fileBridge();
  if (!fig) return [];
  try {
    const p = joinPath(root, "fig", "index.json");
    if (!(await fig.exists(p))) return [];
    const index = JSON.parse(await fig.readText(p)) as FigIndexFile;
    return sortedCanvasMeta(index).map((c) => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

/** Figure mode → deck: append `figure`'s content to `deckId` (null = create a
 *  new deck) as a new slide. Reads/writes the deck ON DISK — slide mode is
 *  never resident while figure mode is (tenancy), so nothing races. */
export async function sendFigureToDeck(
  root: string,
  figure: Pick<Figure, "name" | "elements" | "groups">,
  deckId: string | null,
): Promise<{ deckId: string; slideId: string; title: string }> {
  let deck: Deck | null;
  if (deckId) {
    deck = await readDeck(root, deckId);
    if (!deck) throw new Error(`deck not found or invalid: ${deckId}`);
  } else {
    deck = createDeckModel({ title: `${figure.name} deck`, withTitleSlide: false });
  }
  const slide = slideOps.addSlide(deck, { name: figure.name, layout: "full-bleed" });
  slideOps.addFigureContentToSlide(deck, slide.id, figure);
  await writeDeckDirect(root, deck);
  return { deckId: deck.id, slideId: slide.id, title: deck.title };
}

/** Slide mode → fig/: add a real paper figure holding a fresh-id clone of the
 *  slide's content (beats/overlay dropped) to `canvasId` (null = new canvas).
 *  Loads the FULL fig model, mutates through the shared ops, saves through
 *  the one persistence core (canvas files → captions → index LAST). */
export async function sendSlideToCanvas(
  root: string,
  slide: Slide,
  deck: Pick<Deck, "id" | "stage" | "background" | "theme" | "assets">,
  canvasId: string | null,
): Promise<{ figureId: string; name: string; canvasId: string }> {
  const fig = fileBridge();
  if (!fig) throw new Error("no file bridge");

  // 1. Load the full fig/ model (all canvases) locally — never via the live
  // figure store (slide mode owns it right now).
  let index: FigIndexFile | null = null;
  try {
    const p = joinPath(root, "fig", "index.json");
    if (await fig.exists(p)) index = JSON.parse(await fig.readText(p)) as FigIndexFile;
  } catch {
    index = null;
  }
  const canvasMeta = sortedCanvasMeta(index);
  const canvases = canvasMeta.map((c) => ({ id: c.id, name: c.name }));
  const figures: Figure[] = [];
  for (const cm of canvasMeta) {
    try {
      const p = joinPath(root, "fig", "canvases", `${cm.id}.json`);
      if (await fig.exists(p)) {
        const cf = JSON.parse(await fig.readText(p)) as CanvasFile;
        for (const f of cf.figures ?? []) figures.push({ ...f, canvasId: cm.id });
      }
    } catch {
      /* unreadable canvas — keep going; the save plan rewrites what we loaded */
    }
  }
  const model: FigProject = {
    version: 2,
    name: "",
    canvases,
    figures,
    assets: normalizeIndexAssets(index),
    palette: index?.palette ?? [],
    colorGroups: (index?.colorGroups as FigProject["colorGroups"]) ?? [],
    ...(index?.textStyles !== undefined ? { textStyles: index.textStyles } : {}),
    ...(index?.families !== undefined ? { figureFamilies: index.families } : {}),
  };
  migrateProject(model);
  // Family identity before createFigure appends to it (fig-subsystem loader).
  migrateFigureFamilies(model, familyHintsFrom(index?.figures));

  // 2. Target canvas (create one when asked).
  let cid = canvasId;
  if (!cid || !model.canvases.some((c) => c.id === cid)) {
    cid = newId("canvas");
    model.canvases.push({ id: cid, name: `Canvas ${model.canvases.length + 1}` });
  }

  // 3. The shared clone core + a real Figure sized to the slide frame.
  const { elements, groups } = cloneContentWithFreshIds(slide.elements, slide.groups);
  const created = ops.createFigure(model, {
    canvasId: cid,
    name: slide.name ?? "Slide",
    width: deck.stage.width,
    height: deck.stage.height,
    background: slide.background ?? deck.background ?? "#ffffff",
  });
  created.elements = elements;
  if (Object.keys(groups).length) created.groups = groups;
  if (slide.guides) created.guides = structuredClone(slide.guides);

  // 4. Deck-owned asset bytes referenced by the clone must live in fig/ (a
  // paper figure is self-contained there). Bytes come from the live renderer
  // cache (assetData — slide mode has them loaded); manifests persist next to
  // them exactly like the figure save does.
  const have = new Set(model.assets.map((a) => a.id));
  const referenced = new Set<string>();
  for (const e of elements) if ("assetId" in e) referenced.add((e as { assetId: string }).assetId);
  const liveAssets = get(figProject).assets;
  const manifests = get(plotManifests);
  await fig.mkdir(joinPath(root, "fig"));
  await fig.mkdir(joinPath(root, "fig", "assets"));
  for (const id of referenced) {
    if (have.has(id)) continue; // already a fig/ asset — referenced in place
    const meta = liveAssets.find((a) => a.id === id);
    const url = getAssetData(id);
    if (!meta || !url) continue; // unresolvable — the element shows a placeholder
    const rel = `assets/${id}.${meta.kind}`;
    await fig.writeFile(joinPath(root, "fig", rel), dataUrlToBytes(url));
    const man = manifests[id];
    if (man && !isDerivedManifest(man)) {
      await fig.writeText(joinPath(root, "fig", "assets", `${id}.fluxplot.json`), JSON.stringify(man, null, 2));
    }
    const entry: Asset = { ...meta, path: rel };
    model.assets.push(entry);
    have.add(id);
  }

  // 5. Save through the ONE persistence core (ordering + atomicity intact).
  const plan = planFigSave(model, index);
  const io: FigSaveIO = {
    read: async (rel) => {
      try {
        const abs = joinPath(root, rel);
        return (await fig.exists(abs)) ? await fig.readText(abs) : null;
      } catch {
        return null;
      }
    },
    write: (rel, text) => fig.writeText(joinPath(root, rel), text),
    ...(fig.fsyncDir ? { fsyncDir: (rel: string) => fig.fsyncDir!(joinPath(root, rel)) } : {}),
  };
  await fig.mkdir(joinPath(root, "fig", "canvases"));
  await fig.mkdir(joinPath(root, "fig", "captions"));
  await executeFigSave(plan, io);

  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "send_slide_to_canvas", target: created.id, client: "human" });
  return { figureId: created.id, name: created.name, canvasId: cid };
}
