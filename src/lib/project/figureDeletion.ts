import { get, writable } from "svelte/store";
import { project, embeddedProjectRoot, commit, activeFigureId, selectedFrameId, deleteCanvas } from "../store";
import { deleteFigure } from "../ops";
import { readProjectDependencies, type ProjectUsage } from "./dependencies";
import { fileBridge } from "./types";
import { withLiveFigureUsages } from "./liveFigureUsages";
import { storeTenant } from "../tenancy";

interface DeletionRequest {
  kind: "figure" | "canvas"; id: string; root: string | null;
  names: string[]; usages: ProjectUsage[]; checking: boolean; diagnostic?: string;
}
export const figureDeletion = writable<DeletionRequest | null>(null);
export function cancelFigureDeletion() { figureDeletion.set(null); }
export function confirmFigureDeletion() {
  const request = get(figureDeletion);
  if (!request || request.checking || request.root !== get(embeddedProjectRoot) || storeTenant() !== "figure") return;
  figureDeletion.set(null);
  if (request.kind === "canvas") deleteCanvas(request.id);
  else {
    let next: string | null = null;
    commit((p) => { next = deleteFigure(p, request.id).nextActiveId; });
    activeFigureId.set(next); selectedFrameId.set(null);
  }
}
export async function requestFigureDeletion(kind: "figure" | "canvas", id: string): Promise<void> {
  if (storeTenant() !== "figure") return;
  const p = get(project), root = get(embeddedProjectRoot);
  if (kind === "canvas" && p.canvases.length <= 1) return;
  const figures = p.figures.filter((f) => kind === "figure" ? f.id === id : f.canvasId === id);
  const request: DeletionRequest = { kind, id, root, names: figures.map((f) => f.nickname || f.name), usages: [], checking: true };
  figureDeletion.set(request);
  try {
    const fb = fileBridge();
    if (fb && root) {
      const deps = withLiveFigureUsages(await readProjectDependencies(root, fb), root, get(project).figures);
      request.usages = [...new Map(figures.flatMap((f) => deps.byFigure[f.id] ?? []).map((u) => [`${u.kind}:${u.path}:${u.slideId ?? ""}`, u])).values()];
      if (!deps.complete) request.diagnostic = "Some documents could not be checked. Their references may depend on these figures.";
    }
  } catch { request.diagnostic = "Figure usages could not be checked."; }
  if (get(figureDeletion) !== request) return;
  request.checking = false;
  figureDeletion.set(request);
  if (!request.usages.length && !request.diagnostic) confirmFigureDeletion();
}
