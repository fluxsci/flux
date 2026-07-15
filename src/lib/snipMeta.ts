// Paper-snip provenance, runtime-only. A snip PNG carries its own metadata in a
// flux-snip tEXt chunk (see references/snips.ts); every asset-bytes decode seam
// (import, fig load, deck load) drops what it finds here, keyed by assetId, and
// the FluxFig menu's "copy citation" reads it back. Deliberately NOT persisted
// into the fig/deck models — the PNG bytes are the truth and are saved verbatim,
// so the linkage survives every round-trip without touching a schema.
import { readPngText } from "./figure/pngDpi";
import { SNIP_TEXT_KEYWORD, decodeSnipMeta, parseSidecar, type SnipMeta } from "./references/snips";

const byAsset = new Map<string, SnipMeta>();

/** Decode snip provenance from PNG bytes (tEXt first, then an optional sidecar
 *  text the caller resolved) and remember it for `assetId`. Cheap: the chunk
 *  walk stops at the first IDAT; non-snip PNGs cost a few header comparisons. */
export function captureSnipMeta(assetId: string, bytes: Uint8Array, sidecarText?: string | null): void {
  const meta = decodeSnipMeta(readPngText(bytes, SNIP_TEXT_KEYWORD)) ?? parseSidecar(sidecarText);
  if (meta) byAsset.set(assetId, meta);
}

export function getSnipMeta(assetId: string): SnipMeta | undefined {
  return byAsset.get(assetId);
}

/** Project close/load boundary — stale ids must not leak across projects. */
export function clearSnipMeta(): void {
  byAsset.clear();
}
