import { writable, get } from "svelte/store";
import type { Id } from "./types";

// Runtime cache of asset bytes as data URLs, keyed by asset id. Used both to
// render <image> elements on the canvas and to embed assets when exporting.
// Not persisted directly — placed bytes load at open; other bytes load before copying.
export const assetData = writable<Record<Id, string>>({});

export function setAssetData(id: Id, dataUrl: string) {
  assetData.update((m) => ({ ...m, [id]: dataUrl }));
}

export function getAssetData(id: Id): string | undefined {
  return get(assetData)[id];
}

/** Fill missing image/media bytes from the current project's stored paths.
 * Metadata stays resident; GLBs keep their binary/poster pipeline. A project
 * switch or concurrent replacement must never publish into the new tenant. */
export async function ensureAssetBytes(ids: Iterable<Id>): Promise<void> {
  const stores = await import("./store");
  const { fileBridge, joinPath } = await import("./project/types");
  const { storedAssetPath } = await import("./project/assetPath");
  const owner = get(stores.project), embedded = get(stores.embeddedProjectRoot), directory = get(stores.projectDir);
  const root = embedded ?? directory, bridge = fileBridge();
  const current = () => get(stores.project) === owner && get(stores.embeddedProjectRoot) === embedded && get(stores.projectDir) === directory;
  for (const id of new Set(ids)) {
    const asset = owner.assets.find(a => a.id === id);
    if (asset?.kind === "glb" || getAssetData(id)) continue;
    if (!asset?.path || !bridge || !root || isAssetDirty(id)) throw new Error(`Cannot load asset ${id}: source bytes are unavailable`);
    const generation = assetDirtyGeneration(id), relative = storedAssetPath(`${embedded ? "fig/" : ""}${asset.path}`);
    const path = bridge.projectAssetPath ? await bridge.projectAssetPath(root, relative) : joinPath(root, relative);
    const bytes = new Uint8Array(await bridge.readFile(path));
    if (!current()) throw new Error("Project changed while loading asset bytes");
    if (assetDirtyGeneration(id) !== generation) throw new Error(`Asset ${id} changed while loading its bytes`);
    if (!getAssetData(id)) setAssetData(id, bytesToDataUrl(bytes, mimeFor(asset.kind)));
  }
}

// W8 (FIG-6): asset-byte dirty tracking. saveFigFrom used to rewrite EVERY asset's
// bytes (+ sidecars) on every 700ms debounce — MBs of disk thrash (and a corruption
// window) after any unrelated edit. Import/replace/hot-swap mark the changed asset
// dirty; the save writes only dirty (or never-written) assets and clears the marks.
// setAssetData deliberately does NOT mark dirty — it's also the load path.
const dirtyAssets = new Set<Id>();
const assetWriteGenerations = new Map<Id, number>();
export function markAssetDirty(id: Id) {
  dirtyAssets.add(id);
  assetWriteGenerations.set(id, (assetWriteGenerations.get(id) ?? 0) + 1);
}
export function assetDirtyGeneration(id: Id): number { return assetWriteGenerations.get(id) ?? 0; }
export function isAssetDirty(id: Id): boolean {
  return dirtyAssets.has(id);
}
export function clearAssetDirty(id: Id, generation?: number) {
  if (generation === undefined || generation === assetDirtyGeneration(id)) dirtyAssets.delete(id);
}
/** Reset on load — everything is in sync with disk. */
export function clearAllAssetsDirty() {
  dirtyAssets.clear();
  assetWriteGenerations.clear();
}

// ---------------------------------------------------------------------------
// base64 <-> bytes helpers (chunked to avoid call-stack limits on big files)
// ---------------------------------------------------------------------------
// The engine's own codec where it exists (Chromium 140+; Electron ships it): the
// hand-rolled loop below costs ~13 ms per MB on the main thread — 2.1 s of a project
// open that placed 150 MB of rasters (2026-11-09). Node 22 (flux-core, the pure
// gates) keeps the loop; both produce identical text.
type NativeBase64 = { toBase64?: () => string };
type NativeFromBase64 = { fromBase64?: (text: string) => Uint8Array };
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as NativeBase64).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
export function base64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as NativeFromBase64).fromBase64;
  if (typeof native === "function") { try { return native.call(Uint8Array, b64); } catch { /* the loop reports the same malformed input its own way */ } }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  return base64ToBytes(dataUrl.slice(comma + 1));
}

export function mimeFor(kind: import("./types").Asset["kind"]): string {
  return { png: "image/png", svg: "image/svg+xml", mp4: "video/mp4", glb: "model/gltf-binary" }[kind];
}

// Determine the intrinsic pixel size of an image from its data URL.
export function intrinsicSize(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) { reject(new Error("Image has no valid decoded dimensions")); return; }
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("Image could not be decoded"));
    img.src = dataUrl;
  });
}
