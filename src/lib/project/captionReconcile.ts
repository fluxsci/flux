// The canvas owns captions; .md and index text are projections. Before
// replacing a projection, use the previous index caption as a three-way base.
import type { Figure, Project } from "../types";
import { composeCaption, splitCaption, figurePanels } from "../captions";

export interface CaptionConflict { figureId: string; path: string; model: string; sidecar: string }
export interface CaptionBaseline { model: string; sidecar: string | null }
export function reconcileFigureCaption(f: Figure, sidecar: string | null, base?: string, accepted?: CaptionBaseline): "same" | "imported" | "model" | "conflict" {
  if (sidecar == null) return "model";
  const disk = sidecar.trim();
  const current = composeCaption(f).trim();
  // The accepted raw projection is independent of later panel renames/removal.
  // Re-parsing that old text with the NEW label set invents a disk edit.
  if (accepted && disk === accepted.sidecar?.trim()) return current === accepted.model ? "same" : "model";
  if (accepted) base = accepted.model;
  // Old projections used `(a)` markers. Compare through the same inverse
  // caption grammar so formatting-only legacy differences are unambiguous.
  const canonical = (text: string) => {
    const captions = splitCaption(f, text);
    return captions ? composeCaption({ ...f, captions }).trim() : text.trim();
  };
  if (canonical(disk) === current) return "same";
  if (base !== undefined && canonical(disk) === canonical(base)) return "model";
  if (current === canonical(base ?? "")) {
    // Keep blocks whose label was removed recoverable; clear omitted CURRENT
    // blocks so importing an intentionally shortened caption remains exact.
    const currentIds = new Set(["__figure__", ...figurePanels(f).map(p => p.id)]);
    const orphaned = Object.fromEntries(Object.entries(f.captions ?? {}).filter(([id]) => !currentIds.has(id)));
    f.captions = { ...orphaned, ...(splitCaption(f, disk) ?? { __figure__: disk }) };
    return "imported";
  }
  return "conflict";
}

export async function reconcileCaptionFiles(
  project: Pick<Project, "figures">,
  index: { figures?: readonly { id: string; caption?: string }[] } | null,
  read: (relative: string) => Promise<string | null>,
  accepted?: ReadonlyMap<string, CaptionBaseline>,
): Promise<{ imported: string[]; conflicts: CaptionConflict[]; baselines: Map<string, CaptionBaseline> }> {
  const old = new Map((index?.figures ?? []).map((f) => [f.id, f.caption]));
  const imported: string[] = [], conflicts: CaptionConflict[] = [];
  const baselines = new Map<string, CaptionBaseline>();
  for (const f of project.figures) {
    const path = `fig/captions/${f.id}.md`;
    const disk = await read(path);
    const state = reconcileFigureCaption(f, disk, old.get(f.id), accepted?.get(f.id));
    if (state === "imported") imported.push(f.id);
    else if (state === "conflict") conflicts.push({ figureId: f.id, path, model: composeCaption(f), sidecar: disk! });
    if (state !== "conflict") baselines.set(f.id, { model: composeCaption(f).trim(), sidecar: disk });
  }
  return { imported, conflicts, baselines };
}

export function captionConflictMessage(conflicts: readonly CaptionConflict[]): string {
  return `Caption edits conflict in ${conflicts.map((c) => c.path).join(", ")}. Both the figure caption and its Markdown copy changed; both versions are preserved. Reconcile the Markdown file with the figure caption before saving.`;
}
