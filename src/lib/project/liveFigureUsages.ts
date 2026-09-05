import type { Figure } from "../types";
import type { ProjectDependencies } from "./dependencies";
import { readLiveFigureReferenceDocuments } from "./figureReferenceSync";
import { figureReferenceTokens, snapshotFigureReferences } from "./figureReferenceEdits";
import { createFigureReferenceResolver } from "../figureReferences";

/** Catalog/deletion views include what the user is currently writing, even
 * before autosave. Disk-only dependency scans remain conservative for GC. */
export function withLiveFigureUsages(deps: ProjectDependencies, root: string, figures: readonly Figure[]): ProjectDependencies {
  const live = readLiveFigureReferenceDocuments(root);
  if (!live.length) return deps;
  const paths = new Set(live.map((d) => d.path));
  const byFigure = Object.fromEntries(Object.entries(deps.byFigure).map(([id, uses]) => [id, uses.filter((u) => u.kind !== "manuscript" || !paths.has(u.path))]));
  const resolve = createFigureReferenceResolver(snapshotFigureReferences(figures));
  for (const doc of live) {
    const seen = new Set<string>();
    for (const token of figureReferenceTokens(doc.text)) {
      const ref = resolve(token.token)?.ref;
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      (byFigure[ref.id] ??= []).push({ kind: "manuscript", path: doc.path, label: doc.path, figureId: ref.id });
    }
  }
  return { ...deps, byFigure };
}
