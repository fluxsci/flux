// ---------------------------------------------------------------------------
// Slide presets — the user's machine-global library of reusable SLIDES,
// stored one JSON file per preset under <FluxConfig>/presets/slides/**
// (dev fixture: localStorage via memBridge; design presets' sibling).
//
// A preset is a whole-slide snapshot: elements + groups + beats (animation
// travels with the slide) + background/transition/notes/camera, PLUS the
// bytes of every asset the elements reference (data URLs) so the preset is
// self-contained across projects. Saving reads the PERSISTED slide (the
// composed deck — beat-faithful checkouts fold to base, like autosave);
// inserting goes through the pure `slideOps.insertSlideSnapshot` (fresh ids,
// retargeted tracks) via `commitDeckLive`, then registers the embedded bytes
// under the remapped asset ids. Thumbnails come from the SAME elementToSvg
// the canvas and export use, resolving hrefs from the embedded data.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import type { Id } from "../types";
import { fileBridge } from "../project/types";
import { project } from "../store";
import { getAssetData, setAssetData, markAssetDirty, dataUrlToBytes } from "../assets";
import { plotManifests, plotRecipes, cachePlot } from "../plot/store";
import type { FluxPlotManifest } from "../plot/types";
import { elementToSvg } from "../export";
import { presetRel } from "../presets";
import * as slideOps from "./ops";
import type { SlidePresetSnapshot, SlidePresetAssetEntry } from "./ops";
import { commitDeckLive, currentDeck, selectSlide } from "./store";
import { slideDefaultBackground } from "./deckProject";

export interface SlidePresetEntry {
  rel: string;
  preset: SlidePresetSnapshot;
}

function sane(list: unknown): SlidePresetEntry[] {
  if (!Array.isArray(list)) return [];
  const out: SlidePresetEntry[] = [];
  for (const it of list) {
    const e = it as { rel?: unknown; payload?: unknown };
    if (!e || typeof e.rel !== "string") continue;
    const p = e.payload as SlidePresetSnapshot | undefined;
    if (!p || p.fluxPreset !== 1 || p.kind !== "slide" || typeof p.name !== "string") continue;
    if (!p.slide || !Array.isArray(p.slide.elements)) continue;
    out.push({ rel: e.rel, preset: p });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export async function listSlidePresets(): Promise<SlidePresetEntry[]> {
  try {
    return sane(await fileBridge()?.readSlideLibrary?.());
  } catch {
    return [];
  }
}

export async function deleteSlidePreset(rel: string): Promise<boolean> {
  return (await fileBridge()?.deleteSlideLibrary?.(rel)) ?? false;
}

/** Save a slide of the live deck as a machine-global preset. Reads the
 *  PERSISTED slide from the composed deck (what deck.json would hold).
 *  Returns the rel + any asset ids whose bytes could not be embedded (the
 *  elements stay in the preset; they resolve only where those ids exist). */
export async function saveSlidePreset(
  name: string,
  slideId: Id,
): Promise<{ rel: string; missingAssets: Id[] } | null> {
  const rel = presetRel(name);
  const deck = currentDeck();
  const slide = deck?.slides.find((s) => s.id === slideId);
  if (!rel || !deck || !slide) return null;
  const proj = get(project);
  const manifests = get(plotManifests);
  const recipes = get(plotRecipes);
  const assets: SlidePresetAssetEntry[] = [];
  const missingAssets: Id[] = [];
  const seen = new Set<Id>();
  for (const el of slide.elements) {
    const aid = (el as { assetId?: Id }).assetId;
    if (!aid || seen.has(aid)) continue;
    seen.add(aid);
    const meta = proj.assets.find((a) => a.id === aid);
    const data = getAssetData(aid);
    if (!meta || !data) {
      missingAssets.push(aid);
      continue;
    }
    const entry: SlidePresetAssetEntry = { asset: structuredClone(meta), data };
    // Only a REAL fluxplot manifest rides along — derived ones re-derive at
    // insert (cachePlot), exactly like the import path.
    if (el.type === "plot" && el.manifestRef && manifests[aid]) {
      entry.manifest = manifests[aid];
      if (recipes[aid] !== undefined) entry.recipe = recipes[aid];
    }
    assets.push(entry);
  }
  const baseName = rel.replace(/\.json$/i, "").split("/").pop() || "slide";
  const snap: SlidePresetSnapshot = {
    fluxPreset: 1,
    kind: "slide",
    name: baseName,
    savedAt: new Date().toISOString(),
    stage: structuredClone(deck.stage),
    thumbBackground: slide.background ?? slideDefaultBackground(deck),
    slide: structuredClone(slide),
    ...(assets.length ? { assets } : {}),
  };
  const ok = await fileBridge()?.writeSlideLibrary?.(rel, snap);
  return ok ? { rel, missingAssets } : null;
}

/** Insert a preset into the live deck after the given slide (or at the end),
 *  register the embedded asset bytes under their remapped ids, and select the
 *  new slide. Returns the new slide id (null = no deck loaded). */
export function insertSlidePreset(entry: SlidePresetEntry, afterSlideId?: Id | null): Id | null {
  const snap = entry.preset;
  const deckNow = currentDeck();
  if (!deckNow) return null;
  const idx = afterSlideId ? deckNow.slides.findIndex((s) => s.id === afterSlideId) : -1;
  const at = idx >= 0 ? idx + 1 : undefined;
  const res = commitDeckLive((d) => slideOps.insertSlideSnapshot(d, snap, { at }));
  // Register bytes for the assets the op added (assetData is reactive — the
  // projected elements pick the hrefs up in the same flush).
  for (const e of snap.assets ?? []) {
    const nid = res.assetRemap.get(e.asset.id);
    if (!nid) continue; // reused an existing deck asset — bytes already live
    setAssetData(nid, e.data);
    markAssetDirty(nid); // the deck save writes assets/<nid>.<kind>
    if (e.asset.kind === "svg") {
      try {
        const svgText = new TextDecoder().decode(dataUrlToBytes(e.data));
        cachePlot(nid, svgText, e.manifest as FluxPlotManifest | undefined, e.recipe);
      } catch {
        /* unparsable svg — the <image> fallback still renders from assetData */
      }
    }
  }
  selectSlide(res.slideId);
  return res.slideId;
}

/** SVG thumbnail data-URL for a preset card: the slide's background + its
 *  elements over the saved stage, hrefs resolved from the EMBEDDED bytes. */
export function slidePresetThumb(p: SlidePresetSnapshot): string {
  const dataById = new Map<Id, string>();
  for (const e of p.assets ?? []) dataById.set(e.asset.id, e.data);
  const bg = p.slide.background ?? p.thumbBackground ?? "#100f0f";
  const body = p.slide.elements
    .filter((el) => !el.hidden)
    .map((el) => elementToSvg(el, (id) => dataById.get(id)))
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.stage.width} ${p.stage.height}">` +
    `<rect width="${p.stage.width}" height="${p.stage.height}" fill="${bg}"/>` +
    body +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}
