// Re-run a plot's recipe and hot-swap the result in place (the GUI half of "Apply to source",
// colour-system plan A7.5). Shared by the X-ray's Regenerate button and the colour-scale
// editor in every surface, so the ownership and reimport rules live once: the recipe path is
// project-relative (plot/source.ts) and resolved through the candidates, the output is
// validated before it replaces the asset, and a result whose plot is gone by the time it
// arrives is discarded.
import { get } from "svelte/store";
import type { SemanticPlotElement } from "../types";
import type { FluxPlotManifest } from "./types";
import { validateIncomingPlot } from "./contract";
import { plotSourceCandidates } from "./source";
import { reimportPlot } from "../io";
import { fileBridge } from "../project/types";
import { project, embeddedProjectRoot, projectDir } from "../store";

export interface RegenerateOutcome { ok: boolean; message: string }

/** Run the element's recipe with `params` and reimport its plot. `stillOwned` lets a caller
 *  veto the swap (the X-ray pins the plot it started from); by default the element must still
 *  exist with the same asset and recipe. */
export async function regeneratePlot(el: SemanticPlotElement, params: Record<string, unknown>,
  opts: { jobId?: string; stillOwned?: () => boolean } = {}): Promise<RegenerateOutcome> {
  const fb = fileBridge();
  const recipePath = el.source?.recipePath;
  if (!recipePath || !fb?.runRecipe) return { ok: false, message: "no recipe" };
  const projRoot = get(embeddedProjectRoot) ?? get(projectDir);
  const target = { id: el.id, assetId: el.assetId, recipePath };
  const owned = () => {
    if (opts.stillOwned) return opts.stillOwned();
    const now = get(project).figures.flatMap((f) => f.elements).find((e) => e.id === target.id);
    return now?.type === "plot" && now.assetId === target.assetId && now.source?.recipePath === target.recipePath;
  };
  let recipeAbs = "";
  for (const c of plotSourceCandidates(projRoot, recipePath, el.source)) {
    if (await fb.exists(c)) { recipeAbs = c; break; }
  }
  if (!owned()) return { ok: false, message: "" };
  if (!recipeAbs) return { ok: false, message: "recipe file not found" };
  const res = await fb.runRecipe(recipeAbs, params, { jobId: opts.jobId });
  if (!owned()) return { ok: false, message: "" };
  if (res.code !== 0) {
    const why = String(res.stderr ?? "").trim();
    return { ok: false, message: "recipe failed" + (why ? `: ${why.slice(-200)}` : ` (exit ${res.code})`) };
  }
  if (!res.svgText || !res.manifestText) return { ok: false, message: "no output" };
  await validateIncomingPlot(res.svgText, res.manifestText);
  if (!owned()) return { ok: false, message: "" };
  reimportPlot(target.assetId, res.svgText, JSON.parse(res.manifestText) as FluxPlotManifest, res.recipeText ? JSON.parse(res.recipeText) : undefined);
  return { ok: true, message: "regenerated ✓" };
}
