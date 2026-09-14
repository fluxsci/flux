/** Read-only deck payload gathering, shared by GUI embeds and Node export. */
import { preparePlot, buildPartIndex } from "../plot/parse";
import { plotSourceCandidates } from "../plot/source";
import { danglingTrackTargets, normalizeDeck } from "./ops";
import { validateDeckFile } from "../project/validate";
import { isNewerSchema } from "../project/types";
import { DECK_SCHEMA_VERSION, type Deck } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import type { ExportPayload } from "./export/runtime";
import { slideAssetIds } from "./deckProject";
import type { Asset } from "../types";
import { validEmbedId } from "./embed";
export type { ExportPayload } from "./export/runtime";
export interface SlidePayloadIO {
  readText(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array | ArrayBuffer>;
  /** Authoring/capture hosts stream native files. Portable exports inline bytes. */
  videoUrl?(path: string, asset: Asset): Promise<string>;
}
const join = (...parts: string[]) => parts.join("/");
export function underRoot(root: string, rel: string): string {
  if (/^(?:[a-z]+:|[/\\])/i.test(rel)) throw new Error("Expected a project-relative path");
  const parts: string[] = [];
  for (const p of rel.replace(/\\/g, "/").split("/")) {
    if (p === "..") { if (!parts.length) throw new Error("Path escapes project root"); parts.pop(); }
    else if (p && p !== ".") parts.push(p);
  }
  return `${root.replace(/[/\\]$/, "")}/${parts.join("/")}`;
}
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
const assetMime = (kind: string) => ({ svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[kind] ?? "application/octet-stream");
export async function readEmbedDeck(root: string, id: string, io: SlidePayloadIO): Promise<Deck> {
  if (!validEmbedId(id)) throw new Error("Invalid deck ID");
  const manifest = JSON.parse(await io.readText(underRoot(root, "project.json")));
  const entry = manifest.slides?.find((d: { id: string }) => d.id === id);
  if (!entry) throw new Error("Deck is no longer registered in this project");
  const raw = JSON.parse(await io.readText(underRoot(root, entry.path || `slides/${id}/deck.json`)));
  if (isNewerSchema(raw.schemaVersion, DECK_SCHEMA_VERSION)) throw new Error("This deck needs a newer version of Flux");
  const deck = normalizeDeck(raw);
  const errors = validateDeckFile(deck);
  if (errors.length) throw new Error(`Invalid deck: ${errors.slice(0, 3).join("; ")}`);
  if (deck.id !== id) throw new Error("Deck identity does not match its registry entry");
  return deck;
}
export async function gatherPayload(root: string, deck: Deck, io: SlidePayloadIO): Promise<{ payload: ExportPayload; warnings: string[] }> {
  const readJSON = async <T>(path: string): Promise<T> => JSON.parse(await io.readText(path)) as T;
  const assets: Record<string, string> = {};
  const videos: Record<string, string> = {};
  const assetSizes: Record<string, { width: number; height: number }> = {};
  const plots: Record<string, { svg: string; manifest: FluxPlotManifest }> = {};
  const warnings: string[] = [];

  // The by-id resolution table for figure-derived content.
  let figAssets: { id: string; kind: string; path?: string; naturalWidth?: number; naturalHeight?: number; dpi?: number }[] = [];
  try {
    figAssets = ((await readJSON<{ assets?: typeof figAssets }>(underRoot(root, join("fig", "index.json")))).assets) ?? [];
  } catch {
    /* no fig/ — nothing figure-derived to resolve */
  }
  const displaySize = (a: { kind: string; naturalWidth?: number; naturalHeight?: number; dpi?: number }) => {
    if (!(a.naturalWidth && a.naturalHeight)) return null;
    const k = a.kind === "png" && a.dpi && a.dpi > 0 ? 96 / a.dpi : 1;
    return { width: a.naturalWidth * k, height: a.naturalHeight * k };
  };

  const deckAsset = (id: string) => deck.assets.find((a) => a.id === id);

  // Raster/media bytes by id: deck-local first, then fig/ by id.
  const collectMedia = async (assetId: string): Promise<boolean> => {
    if (assets[assetId] || videos[assetId]) return true;
    const da = deckAsset(assetId);
    if (da?.path) {
      try {
        const file = underRoot(root, join("slides", deck.id, da.path));
        if (da.kind === "mp4") {
          videos[assetId] = io.videoUrl ? await io.videoUrl(file, da)
            : `data:video/mp4;base64,${base64(new Uint8Array(await io.readFile(file)))}`;
        } else {
          const buf = await io.readFile(file);
          assets[assetId] = `data:${assetMime(da.kind)};base64,${base64(new Uint8Array(buf))}`;
        }
        const ds = displaySize(da);
        if (ds) assetSizes[assetId] = ds;
        return true;
      } catch {
        warnings.push(`media asset "${assetId}" missing (${da.path}) — its element will show a placeholder`);
        return false;
      }
    }
    const fa = figAssets.find((x) => x.id === assetId);
    if (fa?.path) {
      try {
        const buf = await io.readFile(underRoot(root, join("fig", fa.path)));
        assets[assetId] = `data:${assetMime(fa.kind)};base64,${base64(new Uint8Array(buf))}`;
        const ds = displaySize(fa);
        if (ds) assetSizes[assetId] = ds;
        return true;
      } catch {
        warnings.push(`fig/ asset "${assetId}" unreadable (${fa.path}) — its element will show a placeholder`);
        return false;
      }
    }
    return false;
  };

  const manifest = await readJSON<import("../project/types").ProjectManifest>(underRoot(root, "project.json")).catch(() => null);
  const plotIndex = ((manifest as unknown as { plots?: { id: string; path?: string; svgPath?: string; manifestPath?: string }[] })?.plots) ?? [];
  const collectPlot = async (assetId: string, svgPath?: string, manifestPath?: string, source?: { external?: boolean }) => {
    if (plots[assetId]) return;
    const entry = plotIndex.find((p) => p.id === assetId);
    const da = deckAsset(assetId);
    const fa = figAssets.find((a) => a.id === assetId);
    // A registered asset is an accepted bundle. Do not substitute a raw SVG
    // or sidecar underneath a frozen/last-good version.
    const saved = da?.path && da.kind === "svg" ? join("slides", deck.id, da.path)
      : fa?.path && fa.kind === "svg" ? join("fig", fa.path) : null;
    const sps = saved ? [underRoot(root, saved)] : [
      ...(svgPath ? plotSourceCandidates(root, svgPath, source) : []),
      ...(entry?.svgPath || entry?.path ? plotSourceCandidates(root, (entry.svgPath ?? entry.path)!) : []),
      underRoot(root, join("plots", `${assetId}.svg`)),
      underRoot(root, join("fig", "assets", `${assetId}.svg`)),
    ];
    for (const sp of sps) {
      try {
        const svg = await io.readText(sp);
        const mps = saved
          ? [underRoot(root, da?.path ? join("slides", deck.id, "assets", `${assetId}.fluxplot.json`) : join("fig", "assets", `${assetId}.fluxplot.json`))]
          : [...(manifestPath ? plotSourceCandidates(root, manifestPath, source) : []), ...(entry?.manifestPath ? plotSourceCandidates(root, entry.manifestPath) : []), sp.replace(/\.svg$/i, ".fluxplot.json")];
        let m: FluxPlotManifest | undefined;
        for (const mp of mps) { try { m = JSON.parse(await io.readText(mp)) as FluxPlotManifest; break; } catch { /* next sidecar candidate */ } }
        // The SAME preparePlot seam the app's cachePlot runs: a sidecar-less
        // vanilla svg gets a DERIVED manifest, a real one gets orphan
        // augmentation — the payload manifest matches what the runtime computes.
        m = preparePlot(svg, m).manifest ?? m;
        plots[assetId] = { svg, manifest: m ?? ({ axes: [], series: [] } as unknown as FluxPlotManifest) };
        return;
      } catch {
        /* next candidate */
      }
    }
    warnings.push(`plot "${assetId}" not found — it will be missing from the export`);
  };

  // Do not embed unplaced movie files retained in the asset registry for Undo.
  // Raster/plot registry diagnostics retain their existing behavior.
  const referenced = new Set(deck.slides.flatMap(slide => [...slideAssetIds(slide)]));
  for (const a of deck.assets ?? []) if (a.kind !== "mp4" || referenced.has(a.id)) await collectMedia(a.id);

  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") {
        await collectPlot(el.assetId, el.source?.svgPath, el.source?.manifestPath, el.source);
        await collectMedia(el.assetId); // <image> fallback bytes
      } else if (el.type === "image") {
        if (!(await collectMedia(el.assetId)))
          warnings.push(`image asset "${el.assetId}" unresolvable — its element will show a placeholder`);
      } else if (el.type === "video") {
        if (!(await collectMedia(el.assetId))) warnings.push(`video asset "${el.assetId}" unresolvable — its element will show a placeholder`);
        if (!(await collectMedia(el.posterAssetId))) warnings.push(`video poster "${el.posterAssetId}" unresolvable — its element will show a placeholder`);
      } else if (el.type === "text" && el.needsLayout) {
        warnings.push(
          `text element "${el.id}" on slide "${s.id}" was edited headlessly and awaits a GUI re-wrap (needsLayout) — its wrapping may differ until the deck is opened once in Flux`,
        );
      }
    }
    for (const b of s.beats) for (const t of b.tracks) {
      if (t.to?.assetId)
        await collectPlot(t.to.assetId, t.to.svgPath as string | undefined, t.to.manifestPath as string | undefined, { external: typeof t.to.external === "boolean" ? t.to.external : undefined });
    }
  }

  // Parity audit: a part-targeting track whose part id the gathered manifest
  // does not cover cannot resolve to real nodes in the export (resolveTargets
  // falls back to the literal id).
  const partIdx = new Map<string, Record<string, unknown>>();
  const coveredPart = (assetId: string, part: string): boolean => {
    if (!partIdx.has(assetId)) partIdx.set(assetId, buildPartIndex(plots[assetId]?.manifest));
    return part in partIdx.get(assetId)!;
  };
  const partWarned = new Set<string>();
  for (const s of deck.slides) {
    for (const b of s.beats) for (const t of b.tracks) {
      if (!t.part) continue;
      const el = s.elements.find((e) => e.id === t.target);
      if (!el || el.type !== "plot" || partWarned.has(el.assetId)) continue;
      const g = plots[el.assetId];
      if (g && !coveredPart(el.assetId, t.part)) {
        partWarned.add(el.assetId);
        warnings.push(`plot "${el.assetId}" has part-level animations (e.g. "${t.part}") its manifest does not cover — no parts tree for them, so those animations will not play in the export (is the .fluxplot.json sidecar missing?)`);
      }
    }
  }
  // Dangling targets are tolerated (they no-op) but the export should say so.
  for (const d of danglingTrackTargets(deck)) {
    warnings.push(`slide "${d.slideId}" beat "${d.beatId}" animates a deleted element ("${d.target}") — the track plays as a no-op`);
  }
  return {
    payload: {
      deck,
      plots,
      assets,
      ...(Object.keys(videos).length ? { videos } : {}),
      ...(Object.keys(assetSizes).length ? { assetSizes } : {}),
    },
    warnings,
  };
}

/** Keep source lookup data until after gathering; portable embeds contain no notes or local paths. */
export async function gatherSlidePayload(root: string, deck: Deck, slideId: string, io: SlidePayloadIO) {
  const slide = deck.slides.find(s => s.id === slideId);
  if (!slide) throw new Error("Slide is no longer in this deck");
  const selectedSlide = { ...slide, beats: slide.beats.map(b => ({ ...b, tracks: b.tracks.filter(t => !t.disabled) })) };
  const ids = slideAssetIds(selectedSlide);
  const selected = { ...deck, slides: [selectedSlide], assets: deck.assets.filter(a => ids.has(a.id)) };
  const result = await gatherPayload(root, selected, io);
  const clean = structuredClone(result.payload);
  for (const s of clean.deck.slides) {
    delete s.notes;
    for (const el of s.elements) if (el.type === "plot") delete el.source;
    for (const b of s.beats) for (const t of b.tracks) if (t.to) {
      for (const k of ["svgPath", "manifestPath", "recipePath", "external", "frozen"]) delete t.to[k];
    }
  }
  clean.deck.assets = clean.deck.assets.map(a => ({ id: a.id, name: a.id, kind: a.kind, path: "", naturalWidth: a.naturalWidth, naturalHeight: a.naturalHeight, ...(a.dpi ? { dpi: a.dpi } : {}), ...(a.durationMs ? { durationMs: a.durationMs } : {}), ...(a.hasAudio != null ? { hasAudio: a.hasAudio } : {}) }));
  // Serialized transform states can also carry authoring source metadata.
  const scrub = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["source", "svgPath", "manifestPath", "recipePath", "sourcePath", "notes"].includes(key)) delete (value as Record<string, unknown>)[key];
      else scrub(child);
    }
  };
  scrub(clean.deck);
  const manifestFields = new Set(["spec", "schemaVersion", "plotType", "size", "panels", "axes", "series", "guides", "overlays", "parts", "build"]);
  for (const plot of Object.values(clean.plots ?? {})) {
    plot.manifest = Object.fromEntries(Object.entries(plot.manifest).filter(([key]) => manifestFields.has(key))) as unknown as FluxPlotManifest;
    plot.manifest.svg = "";
  }
  return { ...result, payload: clean };
}
