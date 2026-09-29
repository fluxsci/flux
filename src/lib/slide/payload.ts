import { validatedModelBytes } from "../model3d/portableBytes";
import { compileSlide } from "./compile";
import { staticModelElement, payloadModelCompileOptions } from "./staticModels";
import { deckModel3dBindings } from "./model3dBindings";
import { readScene3dSidecars } from "../model3d/persistence";
import { staticModelRequest, type StaticModelPosterRequest } from "../model3d/static";
import { modelPartOpacity } from "../model3d/appearance";
import { posterPath } from "../model3d/poster";
import type { Model3dAsset, Scene3dManifest } from "../model3d/types";
/** Read-only deck payload gathering, shared by GUI embeds and Node export. */
import { preparePlot, buildPartIndex } from "../plot/parse";
import { plotSourceCandidates } from "../plot/source";
import { danglingTrackTargets, normalizeDeck } from "./ops";
import { validateDeckFile } from "../project/validate";
import { isNewerSchema } from "../project/types";
import { DECK_SCHEMA_VERSION, type Deck, type Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import type { ExportPayload } from "./export/runtime";
import { slideAssetIds } from "./deckProject";
import type { Asset } from "../types";
import { validEmbedId } from "./embed";
export type { ExportPayload } from "./export/runtime";
export interface SlidePayloadIO {
  readText(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array | ArrayBuffer>;
  /** Bounded, confined native/Node read; shared gathering still verifies prepared digest. */
  readModelFile?(path: string, root: string): Promise<Uint8Array | ArrayBuffer>;
  /** Authoring/capture hosts stream native files. Portable exports inline bytes. */
  videoUrl?(path: string, asset: Asset): Promise<string>;
  /** Static writers keep model bytes cold; native/worker poster preparation is separate. */
  modelData?: "inline" | "omit";
  modelPoster?(request: StaticModelPosterRequest, projectRelativePath: string): Promise<string>;
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
  const models: Record<string, string> = {}, modelPosters: Record<string, string> = {};
  const modelManifests: Record<string, Scene3dManifest> = {};
  const modelFiles = new Map<string, { asset: Model3dAsset; relative: string }>();
  const modelBindings = deckModel3dBindings(deck);
  const assetSizes: Record<string, { width: number; height: number }> = {};
  const plots: Record<string, { svg: string; manifest: FluxPlotManifest }> = {};
  const warnings: string[] = [];

  // The by-id resolution table for figure-derived content.
  let figAssets: Asset[] = [];
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

  const collectModel = async (asset: Model3dAsset, prefix: string) => {
    const relative = join(prefix, asset.path);
    const file = underRoot(root, relative);
    const sidecars = await readScene3dSidecars({ readText: p => io.readText(p), exists: async p => {
      try { await io.readText(p); return true; } catch { return false; }
    } }, underRoot(root, `${prefix}/assets`), asset.id, { binding: modelBindings.get(asset.id) });
    if (sidecars.manifest) modelManifests[asset.id] = sidecars.manifest;
    warnings.push(...sidecars.issues ?? []);
    if (io.modelData !== "omit") models[asset.id] = base64(await validatedModelBytes(await (io.readModelFile ? io.readModelFile(file, root) : io.readFile(file)), asset));
    modelFiles.set(asset.id, { asset, relative });
  };

  // Raster/media bytes by id: deck-local first, then fig/ by id.
  const collectMedia = async (assetId: string): Promise<boolean> => {
    if (assets[assetId] || videos[assetId] || modelFiles.has(assetId)) return true;
    const da = deckAsset(assetId);
    if (da?.path) {
      try {
        const file = underRoot(root, join("slides", deck.id, da.path));
        if (da.kind === "glb") { await collectModel(da as Model3dAsset, `slides/${deck.id}`); return true; }
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
      } catch (error) {
        if (da.kind === "glb") throw new Error(`Cannot export 3D model "${da.name || da.id}": ${error instanceof Error ? error.message : error}`);
        warnings.push(`media asset "${assetId}" missing (${da.path}) — its element will show a placeholder`);
        return false;
      }
    }
    const fa = figAssets.find((x) => x.id === assetId);
    if (fa?.path) {
      try {
        if (fa.kind === "glb") { await collectModel(fa as Model3dAsset, "fig"); return true; }
        const buf = await io.readFile(underRoot(root, join("fig", fa.path)));
        assets[assetId] = `data:${assetMime(fa.kind)};base64,${base64(new Uint8Array(buf))}`;
        const ds = displaySize(fa);
        if (ds) assetSizes[assetId] = ds;
        return true;
      } catch (error) {
        if (fa.kind === "glb") throw new Error(`Cannot export 3D model "${fa.name || fa.id}": ${error instanceof Error ? error.message : error}`);
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
  for (const a of deck.assets ?? []) if ((a.kind !== "mp4" && a.kind !== "glb") || referenced.has(a.id)) await collectMedia(a.id);

  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") {
        await collectPlot(el.assetId, el.source?.svgPath, el.source?.manifestPath, el.source);
        await collectMedia(el.assetId); // <image> fallback bytes
      } else if (el.type === "model3d") {
        if (!(await collectMedia(el.assetId))) warnings.push(`3D model "${el.assetId}" unresolvable — showing a placeholder`);
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
      if (t.to?.assetId && (deckAsset(t.to.assetId)?.kind === "glb" || figAssets.find(a => a.id === t.to?.assetId)?.kind === "glb")) await collectMedia(t.to.assetId);
      else if (t.to?.assetId)
        await collectPlot(t.to.assetId, t.to.svgPath as string | undefined, t.to.manifestPath as string | undefined, { external: typeof t.to.external === "boolean" ? t.to.external : undefined });
    }
  }

  // Gather every evaluated static endpoint (including rect -> model Consume).
  // Ordinary model identities retain Design appearance; sampled placement can
  // change poster dimensions, and each step's mesh-part visibility is part of
  // its still (a hidden part is absent). Content-only models use their full
  // endpoint state.
  if (modelFiles.size) {
    const metadata = { ...deck, assets: [...new Map([...deck.assets, ...[...modelFiles.values()].map(row => row.asset)].map(a => [a.id, a])).values()] };
    const context = { deck: metadata, plots, modelManifests };
    for (const slide of deck.slides) {
      const compiled = compileSlide(slide, deck.stage, payloadModelCompileOptions(context));
      for (let step = 0; step < Math.max(1, slide.beats.length); step++) {
        const frame = compiled.sample(step);
        for (const sampled of frame.elements) {
          const el = staticModelElement(sampled, slide);
          if (el.type !== 'model3d') continue;
          const source = modelFiles.get(el.assetId); if (!source) continue;
          const request = staticModelRequest(el, source.asset, modelManifests[el.assetId], 'slide', modelPartOpacity(frame.partStates[el.id]));
          if (step === 0) modelPosters[el.id] = request.ref;
          if (!assets[request.ref]) {
            try { assets[request.ref] = io.modelPoster ? await io.modelPoster(request, source.relative)
              : `data:image/png;base64,${base64(new Uint8Array(await io.readFile(underRoot(root, posterPath(request.key)))))}`; }
            catch { warnings.push(`3D model "${el.name || el.id}": poster unavailable; open the model in Flux to render a still`); }
          }
        }
      }
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
  const portableDeck = { ...deck, assets: [...deck.assets] };
  for (const { asset } of modelFiles.values()) if (!portableDeck.assets.some(a => a.id === asset.id)) portableDeck.assets.push(asset);
  return { payload: portablePayload({ deck: portableDeck, plots, assets,
    ...(Object.keys(videos).length ? { videos } : {}),
    ...(modelFiles.size ? { models, modelManifests, modelPosters } : {}),
    ...(Object.keys(assetSizes).length ? { assetSizes } : {}),
  }), warnings };
}

/** Keep source lookup data until after gathering; portable embeds contain no notes or local paths. */
export async function gatherSlidePayload(root: string, deck: Deck, slideId: string, io: SlidePayloadIO) {
  const slide = deck.slides.find(s => s.id === slideId);
  if (!slide) throw new Error("Slide is no longer in this deck");
  const selectedSlide = { ...slide, beats: slide.beats.map(b => ({ ...b, tracks: exportedTracks(b.tracks) })) };
  const ids = slideAssetIds(selectedSlide);
  const selected = { ...deck, slides: [selectedSlide], assets: deck.assets.filter(a => ids.has(a.id)) };
  const result = await gatherPayload(root, selected, io);
  return { ...result, payload: portablePayload(result.payload, { notes: false }) };
}

/** The tracks a per-slide payload carries: enabled tracks; disabled births (they still own their
 *  unborn result identities); and every disabled track a kept track's timing anchor names,
 *  directly or through a chain. Masking is non-destructive, so a follower keeps its start
 *  (slide/resolve.ts). Such a track plays nothing, so it drops its endpoint (`to`) and never
 *  makes an asset required. */
function exportedTracks(tracks: Track[]): Track[] {
  const byId = new Map(tracks.flatMap(t => t.id ? [[t.id, t] as const] : []));
  const kept = new Set(tracks.filter(t => !t.disabled || !!t.ghostFrom));
  const anchorOnly = new Set<Track>();
  for (const pending = [...kept]; pending.length;) {
    const named = byId.get(pending.pop()!.anchor?.trackId ?? "");
    if (named && !kept.has(named)) { kept.add(named); anchorOnly.add(named); pending.push(named); }
  }
  return tracks.filter(t => kept.has(t)).map(t => {
    if (!anchorOnly.has(t) || !t.to) return t;
    const { to: _endpoint, ...timing } = t;
    return timing;
  });
}

/** One portable projection for full presenter decks and Paper occurrences. */
export function portablePayload(payload: ExportPayload, opts: { notes?: boolean } = {}): ExportPayload {
  const clean = structuredClone(payload);
  for (const s of clean.deck.slides) {
    if (opts.notes === false) delete s.notes;
    for (const el of s.elements) if (el.type === "plot") delete el.source;
    for (const b of s.beats) for (const t of b.tracks) if (t.to) {
      for (const k of ["svgPath", "glbPath", "sha256", "manifestPath", "recipePath", "external", "frozen"]) delete t.to[k];
    }
  }
  clean.deck.assets = clean.deck.assets.map(a => ({ id: a.id, name: a.id, kind: a.kind, path: "", naturalWidth: a.naturalWidth, naturalHeight: a.naturalHeight, ...(a.dpi ? { dpi: a.dpi } : {}), ...(a.durationMs ? { durationMs: a.durationMs } : {}), ...(a.hasAudio != null ? { hasAudio: a.hasAudio } : {}), ...(a.kind === "glb" ? { model: a.model, sha256: a.sha256, bytes: a.bytes } : {}) }));
  // Serialized transform states can also carry authoring source metadata.
  const scrub = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["source", "svgPath", "glbPath", "manifestPath", "recipePath", "sourcePath", "externalAssetSizes", "generatedBy", ...(opts.notes === false ? ["notes"] : [])].includes(key)) delete (value as Record<string, unknown>)[key];
      else scrub(child);
    }
  };
  scrub(clean.deck);
  const manifestFields = new Set(["spec", "schemaVersion", "plotType", "size", "panels", "axes", "series", "guides", "overlays", "parts", "build"]);
  for (const plot of Object.values(clean.plots ?? {})) {
    plot.manifest = Object.fromEntries(Object.entries(plot.manifest).filter(([key]) => manifestFields.has(key))) as unknown as FluxPlotManifest;
    plot.manifest.svg = "";
  }
  for (const manifest of Object.values(clean.modelManifests ?? {})) { delete manifest.build; manifest.glb = "model.glb"; }
  return clean;
}
