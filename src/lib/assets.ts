import { writable, get } from "svelte/store";
import type { Id } from "./types";

// Runtime cache of asset bytes as data URLs, keyed by asset id. Used both to
// render <image> elements on the canvas and to embed assets when exporting.
// Not persisted directly — rebuilt from the assets/ folder on open.
export const assetData = writable<Record<Id, string>>({});

export function setAssetData(id: Id, dataUrl: string) {
  assetData.update((m) => ({ ...m, [id]: dataUrl }));
}

export function getAssetData(id: Id): string | undefined {
  return get(assetData)[id];
}

// W8 (FIG-6): asset-byte dirty tracking. saveFigFrom used to rewrite EVERY asset's
// bytes (+ sidecars) on every 700ms debounce — MBs of disk thrash (and a corruption
// window) after any unrelated edit. Import/replace/hot-swap mark the changed asset
// dirty; the save writes only dirty (or never-written) assets and clears the marks.
// setAssetData deliberately does NOT mark dirty — it's also the load path.
const dirtyAssets = new Set<Id>();
export function markAssetDirty(id: Id) {
  dirtyAssets.add(id);
}
export function isAssetDirty(id: Id): boolean {
  return dirtyAssets.has(id);
}
export function clearAssetDirty(id: Id) {
  dirtyAssets.delete(id);
}
/** Reset on load — everything is in sync with disk. */
export function clearAllAssetsDirty() {
  dirtyAssets.clear();
}

// ---------------------------------------------------------------------------
// base64 <-> bytes helpers (chunked to avoid call-stack limits on big files)
// ---------------------------------------------------------------------------
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = dataUrl.slice(comma + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function mimeFor(kind: "png" | "svg"): string {
  return kind === "png" ? "image/png" : "image/svg+xml";
}

// Determine the intrinsic pixel size of an image from its data URL.
export function intrinsicSize(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || 300,
        height: img.naturalHeight || 200,
      });
    img.onerror = () => resolve({ width: 300, height: 200 });
    img.src = dataUrl;
  });
}
