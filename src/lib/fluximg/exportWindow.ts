/**
 * The window's IO for `exportStatic.prepareFluximgContext`: stills from the open project's decode-worker pool.
 *
 * In-app exports (SVG / PNG / TIFF / PDF) and Paper call this before serializing a figure. A still is asked for under
 * the editor's own cache key, so an export at a size the canvas already drew costs nothing, and the worker draws it
 * with `still.renderStill`, the function flux-core calls: the same view gives the same pixels in both engines.
 * Loaded lazily by its callers (`import()`), like model3d's export posters.
 */
import { get } from "svelte/store";
import { embeddedProjectRoot, projectDir } from "../store";
import type { Asset, Figure } from "../types";
import { fluximgBundle, fluximgService } from "./store";
import {
  prepareFluximgContext, visibleFluximgElements,
  type FluximgExportIO, type FluximgExportSurface, type FluximgSvgContext,
} from "./exportStatic";
import type { FluximgElement } from "./element";

const openRoot = (): string => get(embeddedProjectRoot) ?? get(projectDir) ?? "";

/**
 * Stills and layer files through the window's service. `root`, when given, is the project the figure was read from
 * (Paper reads figures from disk): the service serves the project open in this window only, so a different root
 * is reported per element instead of reading another project's files.
 */
export function windowFluximgIO(root?: string): FluximgExportIO {
  const service = () => {
    if (root !== undefined && root !== openRoot()) throw new Error("its project is not the one open in this window");
    return fluximgService();
  };
  return {
    manifest: async (asset) => service().manifest(fluximgBundle(asset)),
    // No slot: an export's request must never be replaced by the editor's next still for the same element.
    still: async (_asset, r) => service().still(r.key, { bundle: r.bundle, view: r.view, crop: r.crop, outWidth: r.outWidth, outHeight: r.outHeight }),
    text: async (asset, path) => service().text(fluximgBundle(asset), path),
  };
}

export interface WindowFluximgOptions {
  namespace?: string;
  root?: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onIssue?: (element: FluximgElement, message: string) => void;
}

/** The image context of some figures for one output, or undefined when they hold no visible fluximg. */
export async function prepareWindowFluximg(figures: readonly Figure[], assets: readonly Asset[], surface: FluximgExportSurface, options: WindowFluximgOptions = {}): Promise<FluximgSvgContext | undefined> {
  if (!visibleFluximgElements(figures).length) return undefined;
  const { signal, isCurrent } = options;
  return prepareFluximgContext(figures, assets, windowFluximgIO(options.root), {
    surface, namespace: options.namespace, onIssue: options.onIssue,
    isCurrent: signal || isCurrent ? () => !signal?.aborted && (isCurrent?.() ?? true) : undefined,
  });
}
