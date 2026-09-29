import { staticModelRequest } from '../../model3d/static';
/** Lightweight adapter to the conditional 3D IIFE. No eager Three dependency. */
import type { ExportPayload } from './runtime';
import type { InlineHost, InlineHostOptions } from '../../model3d/inlineHost';
import type { Model3dAsset, Model3dElement } from '../../model3d/types';
export function payloadModelHost(payload: ExportPayload) {
  if (!Object.keys(payload.models ?? {}).length) return undefined;
  const runtime = (globalThis as unknown as { FluxModel3dRuntime?: { createInlineHost(options: InlineHostOptions): InlineHost } }).FluxModel3dRuntime;
  if (!runtime) return undefined;
  const bytes = new Map<string, ArrayBuffer>();
  try {
    return runtime.createInlineHost({
      modelBytes: async id => {
        let buffer = bytes.get(id);
        if (!buffer) {
          const encoded = payload.models?.[id]; if (!encoded) throw new Error(`Missing 3D model ${id}`);
          const text = atob(encoded), array = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i++) array[i] = text.charCodeAt(i);
          buffer = array.buffer; bytes.set(id, buffer);
        }
        return buffer;
      },
      manifest: id => payload.modelManifests?.[id],
    });
  } catch { return undefined; } // WebGL unavailable: the same player draws the saved still.
}
export function payloadModelContext(payload: ExportPayload) {
  return {
    modelAsset: (id: string) => payload.deck.assets.find((a): a is Model3dAsset => a.id === id && a.kind === 'glb'),
    modelManifest: (id: string) => payload.modelManifests?.[id],
    modelPoster: (element: Model3dElement) => {
      const asset = payload.deck.assets.find((a): a is Model3dAsset => a.id === element.assetId && a.kind === 'glb');
      if (!asset) return undefined;
      // The payload carries Design stills. Never relabel that image as a later
      // orbit, shape or content endpoint when live rendering is unavailable.
      try { return payload.assets?.[staticModelRequest(element, asset, payload.modelManifests?.[element.assetId], 'slide').ref]; }
      catch { return undefined; }
    },
  };
}
