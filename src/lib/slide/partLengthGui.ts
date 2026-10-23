// ---------------------------------------------------------------------------
// Flux Slide — the GUI's pen-length measure for the auto-build: the SAME `plotPenLengths` the headless
// `animate-plot` verb calls, on the pristine `<svg>` the plot store caches (`plotDom`). Absent DOM (the lazy
// plot has not parsed yet) or a pace that scales nothing -> undefined, and the build uses its authored windows.
// ---------------------------------------------------------------------------
import { plotDom } from "../plot/store";
import type { FluxPlotManifest } from "../plot/types";
import { paceUsesLengths, type AutoPace } from "./autobuild";
import { plotPenLengths } from "./partLength";

export function guiPenLengths(assetId: string, manifest: FluxPlotManifest | undefined, placedWidth: number, pace?: AutoPace): Record<string, number> | undefined {
  if (!paceUsesLengths(pace)) return undefined;
  const root = plotDom.get(assetId);
  return root ? plotPenLengths(root, manifest, placedWidth) : undefined;
}
