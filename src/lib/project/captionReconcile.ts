// The canvas owns captions; .md and index text are projections. Before
// replacing a projection, use the previous index caption as a three-way base.
import type { Figure, Project } from "../types";
import { composeCaption, splitCaption } from "../captions";

export interface CaptionConflict { figureId: string; path: string; model: string; sidecar: string }
export function reconcileFigureCaption(f: Figure, sidecar: string | null, base?: string): "same" | "imported" | "model" | "conflict" {
  if (sidecar == null) return "model";
  const disk = sidecar.trim();
  const current = composeCaption(f).trim();
  // Old projections used `(a)` markers. Compare through the same inverse
  // caption grammar so formatting-only legacy differences are unambiguous.
  const canonical = (text: string) => {
    const captions = splitCaption(f, text);
    return captions ? composeCaption({ ...f, captions }).trim() : text.trim();
  };
  if (canonical(disk) === current) return "same";
  if (base !== undefined && canonical(disk) === canonical(base)) return "model";
  if (current === canonical(base ?? "")) {
    f.captions = splitCaption(f, disk) ?? { __figure__: disk };
    return "imported";
  }
  return "conflict";
}

export async function reconcileCaptionFiles(
  project: Pick<Project, "figures">,
  index: { figures?: readonly { id: string; caption?: string }[] } | null,
  read: (relative: string) => Promise<string | null>,
): Promise<{ imported: string[]; conflicts: CaptionConflict[] }> {
  const old = new Map((index?.figures ?? []).map((f) => [f.id, f.caption]));
  const imported: string[] = [], conflicts: CaptionConflict[] = [];
  for (const f of project.figures) {
    const path = `fig/captions/${f.id}.md`;
    const disk = await read(path);
    const state = reconcileFigureCaption(f, disk, old.get(f.id));
    if (state === "imported") imported.push(f.id);
    else if (state === "conflict") conflicts.push({ figureId: f.id, path, model: composeCaption(f), sidecar: disk! });
  }
  return { imported, conflicts };
}

export function captionConflictMessage(conflicts: readonly CaptionConflict[]): string {
  return `Caption edits conflict in ${conflicts.map((c) => c.path).join(", ")}. Both the figure caption and its Markdown copy changed; both versions are preserved. Reconcile the Markdown file with the figure caption before saving.`;
}
