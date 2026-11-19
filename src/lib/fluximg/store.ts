/**
 * The window's fluximg state: ONE service (decode workers + caches) bound to the open project, and the small
 * stores the canvas, the live view and the Inspector read.
 *
 * Pixels never pass through here as store values. Stores hold manifests (kilobytes), layer SVG text and a
 * revision counter; planes and stills stay inside the service's bounded caches.
 */
import { get, writable } from "svelte/store";
import { embeddedProjectRoot, projectDir } from "../store";
import { fileBridge } from "../project/types";
import { ensureColormapLuts, colormapLut } from "../color/colormapLuts";
import type { Asset } from "../types";
import { FluximgService } from "./service";
import type { FluximgManifest } from "./types";

/** Manifests of the bundles in use, by asset id. `needManifest` fills it. */
export const fluximgManifests = writable<Record<string, FluximgManifest>>({});
/** Why a bundle cannot be shown (missing files, a spec this Flux does not read), by asset id. */
export const fluximgIssues = writable<Record<string, string>>({});
/** Layer SVG text by `${assetId}|${path}`: outlines and vector layers, loaded when a layer is first shown. */
export const fluximgLayerText = writable<Record<string, string>>({});
/** Bumped whenever a placed fluximg paints different pixels, so a cached picture of the scene is retaken. */
export const fluximgStillRevision = writable(0);
/** True once the colour-map tables are loaded on this thread (the live view's tables need them). */
export const fluximgLutsReady = writable(false);

let service: FluximgService | null = null;
let boundRoot = "";
const manifestsPending = new Map<string, Promise<FluximgManifest>>();
const textsPending = new Set<string>();

const currentRoot = (): string => get(embeddedProjectRoot) ?? get(projectDir) ?? "";

function reset(): void {
  service?.dispose();
  service = null;
  manifestsPending.clear();
  textsPending.clear();
  fluximgManifests.set({});
  fluximgIssues.set({});
  fluximgLayerText.set({});
}

// Another project (or none): everything known belongs to the old one.
for (const store of [embeddedProjectRoot, projectDir]) store.subscribe(() => { if (boundRoot !== currentRoot()) { boundRoot = currentRoot(); reset(); } });

/** The service for the open project. Created on first use; replaced when the project changes. */
export function fluximgService(): FluximgService {
  if (service) return service;
  const root = currentRoot();
  boundRoot = root;
  service = new FluximgService({
    read: (request) => {
      const bridge = fileBridge();
      if (!bridge?.readFluximg) return Promise.reject(new Error("Images need the Flux desktop app or a saved project"));
      if (!root) return Promise.reject(new Error("Open a saved Flux project before adding an image"));
      return bridge.readFluximg({ root, ...request });
    },
  });
  return service;
}

/** The bundle directory of a placed asset, relative to the project root (`Asset.path` is relative to `fig/`). */
export function fluximgBundle(asset: Pick<Asset, "path">): string {
  return `fig/${asset.path.replace(/^\/+/, "")}`;
}

/** The identity of an asset's PIXELS for cache keys: its content id when known, its id otherwise. */
export function fluximgIdentity(asset: Pick<Asset, "id" | "sha256">): string {
  return asset.sha256 ?? asset.id;
}

/** Load (once) and publish an asset's manifest. A failure is published to `fluximgIssues` and rethrown. */
export function needManifest(asset: Pick<Asset, "id" | "path">): Promise<FluximgManifest> {
  const known = get(fluximgManifests)[asset.id];
  if (known) return Promise.resolve(known);
  let p = manifestsPending.get(asset.id);
  if (p) return p;
  const svc = fluximgService();
  p = svc.manifest(fluximgBundle(asset)).then(
    (manifest) => {
      if (service !== svc) throw new Error("The project changed while working on the image");
      fluximgManifests.update((m) => ({ ...m, [asset.id]: manifest }));
      fluximgIssues.update((m) => { if (!(asset.id in m)) return m; const next = { ...m }; delete next[asset.id]; return next; });
      return manifest;
    },
    (error: unknown) => {
      manifestsPending.delete(asset.id);
      if (service === svc) fluximgIssues.update((m) => ({ ...m, [asset.id]: error instanceof Error ? error.message : String(error) }));
      throw error;
    },
  );
  manifestsPending.set(asset.id, p);
  return p;
}

/** Load (once) and publish the SVG text of a layer file. Safe to call on every render. */
export function needLayerText(asset: Pick<Asset, "id" | "path">, path: string): void {
  const key = `${asset.id}|${path}`;
  if (textsPending.has(key) || key in get(fluximgLayerText)) return;
  textsPending.add(key);
  const svc = fluximgService();
  void svc.text(fluximgBundle(asset), path).then(
    (text) => { if (service === svc) fluximgLayerText.update((m) => ({ ...m, [key]: text })); },
    () => { textsPending.delete(key); },
  );
}

/** A bundle's files changed on disk or it was re-imported: forget everything derived from it. */
export function forgetFluximg(asset: Pick<Asset, "id" | "path">): void {
  manifestsPending.delete(asset.id);
  for (const key of [...textsPending]) if (key.startsWith(`${asset.id}|`)) textsPending.delete(key);
  fluximgManifests.update((m) => { if (!(asset.id in m)) return m; const next = { ...m }; delete next[asset.id]; return next; });
  fluximgLayerText.update((m) => { const next: Record<string, string> = {}; for (const [k, v] of Object.entries(m)) if (!k.startsWith(`${asset.id}|`)) next[k] = v; return next; });
  service?.forget(fluximgBundle(asset));
  fluximgStillRevision.update((n) => n + 1);
}

let lutsLoading: Promise<void> | null = null;
/** Load the colour-map tables on this thread (lazy: the startup budget forbids importing them eagerly). */
export function needLuts(): Promise<void> {
  lutsLoading ??= ensureColormapLuts().then(() => { fluximgLutsReady.set(true); });
  return lutsLoading;
}
/** A colour map's 256 entries, or null when unknown or not loaded yet. */
export const resolveLut = (name: string): string[] | null => colormapLut(name)?.lut ?? null;
