// Permanent figure identity. Publication numbers and document order never enter
// this contract: a title/number/canvas change cannot retarget a manuscript link.
import type { Figure, Project } from "../types";
import { slugify } from "./types";

export function figureTitle(f: Pick<Figure, "name" | "nickname">): string {
  return f.nickname?.trim() || f.name;
}

export function deriveFigureReferenceKey(f: { id: string; name: string }): string {
  const slugLike = /^[a-z0-9][a-z0-9-]*$/i.test(f.id);
  return `fig-${slugLike ? f.id : slugify(f.name || f.id)}`;
}

/** New figures anchor to their permanent ID, never a reusable display name.
 * Legacy migration deliberately keeps deriveFigureReferenceKey above. */
export function mintFigureReferenceKey(id: string, figures: readonly Pick<Figure, "id" | "referenceKey">[] = []): string {
  const base = `fig-${id.replace(/[^A-Za-z0-9-]/g, "-")}`;
  const used = new Set(figures.filter((f) => f.id !== id).map((f) => f.referenceKey).filter(Boolean));
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  return key;
}

/** Additive migration: take an existing index label EXACTLY once, then the
 * canonical figure owns it. Never silently repair existing collisions: doing
 * so could redirect prose. Fresh figures claim unused keys deterministically. */
export function ensureFigureReferenceKeys(
  project: Pick<Project, "figures">,
  hints?: { figures?: readonly { id: string; label?: string }[] } | null,
): string[] {
  const previous = new Map((hints?.figures ?? []).map((f) => [f.id, f.label]));
  const used = new Set<string>();
  for (const f of project.figures) {
    const key = f.referenceKey || previous.get(f.id);
    if (key) used.add(key);
  }
  const changed: string[] = [];
  for (const f of project.figures) {
    if (f.referenceKey) continue;
    let key = previous.get(f.id);
    if (!key) {
      const base = deriveFigureReferenceKey({ id: f.id, name: figureTitle(f) });
      key = base;
      for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    }
    f.referenceKey = key;
    used.add(key);
    changed.push(f.id);
  }
  return changed;
}
