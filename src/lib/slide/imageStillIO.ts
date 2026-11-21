/** Browser payload IO for images (fluximg): stills, layer files and tables through the window's decode workers, the
 *  same service the editor draws with (`fluximg/exportWindow.ts`). Static writers (PDF, PowerPoint) and Paper's slide
 *  embeds gather through it; no clip is baked in the window (the encoder is Node-only), so those show stills. */
import type { SlidePayloadIO } from "./payload";
import type { FluximgExportIO } from "../fluximg/exportStatic";

export function slideImageStillIO<T extends SlidePayloadIO>(root: string, io: T): T {
  if (io.imageStill || typeof window === "undefined") return io;
  let windowIO: Promise<FluximgExportIO> | undefined;
  // Loaded on first use only: a deck without images never imports the image service.
  const w = () => (windowIO ??= import("../fluximg/exportWindow").then((m) => m.windowFluximgIO(root)));
  return {
    ...io,
    imageManifest: async (asset) => (await w()).manifest(asset),
    imageStill: async (asset, request) => (await w()).still(asset, request),
    imageText: async (asset, path) => (await w()).text(asset, path),
    imageTable: async (asset, path) => (await w()).table(asset, path),
  };
}
