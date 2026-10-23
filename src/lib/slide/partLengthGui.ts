// ---------------------------------------------------------------------------
// Flux Slide — the GUI's plot measures for the auto-build: the SAME `plotMeasures` the headless `animate-plot`
// verb calls, on the pristine `<svg>` the plot store caches (`plotDom`). Absent DOM (the lazy plot has not parsed
// yet) or a pace that measures nothing -> {}, and the build uses its authored windows.
// ---------------------------------------------------------------------------
import { plotDom } from "../plot/store";
import type { FluxPlotManifest } from "../plot/types";
import { paceUsesLengths, type AutoBuildOptions, type AutoPace } from "./autobuild";
import { plotMeasures } from "./partLength";

export function guiPlotMeasures(assetId: string, manifest: FluxPlotManifest | undefined, placedWidth: number, pace?: AutoPace): Pick<AutoBuildOptions, "lengths" | "stagePerUnit"> {
  if (!paceUsesLengths(pace)) return {};
  const root = plotDom.get(assetId);
  return root ? plotMeasures(root, manifest, placedWidth) : {};
}
