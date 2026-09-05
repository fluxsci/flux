// Read-only usage index. Include decks and animation-only targets before GC.
import { createFigureReferenceResolver } from "../figureReferences";
import { panelLetters } from "../captions";
import { figureReferenceTokens } from "./figureReferenceEdits";
export interface DependencyIO {
  readText(path: string): Promise<string>;
  readdir?(path: string): Promise<{ name: string; dir: boolean }[]>;
  stat?(path: string): Promise<{ mtimeMs: number; size: number } | null>;
}
export interface ProjectUsage {
  kind: "figure" | "manuscript" | "slide";
  path: string;
  figureId?: string;
  deckId?: string;
  slideId?: string;
  elementId?: string;
  trackId?: string;
  label: string;
}
export interface ProjectDependencies {
  byFigure: Record<string, ProjectUsage[]>;
  byAsset: Record<string, ProjectUsage[]>;
  diagnostics: string[];
  complete: boolean;
}
const textCache = new Map<string, { signature: string; text: string }>();
export async function readProjectDependencies(root: string, io: DependencyIO): Promise<ProjectDependencies> {
  const out: ProjectDependencies = { byFigure: {}, byAsset: {}, diagnostics: [], complete: true };
  const read = async (rel: string): Promise<string> => {
    const path = `${root}/${rel}`;
    const stat = await io.stat?.(path);
    const signature = stat ? `${stat.mtimeMs}:${stat.size}` : null;
    const cached = textCache.get(path);
    if (signature && cached?.signature === signature) return cached.text;
    const text = await io.readText(path);
    if (signature) {
      if (textCache.size >= 1024) textCache.delete(textCache.keys().next().value!);
      textCache.set(path, { signature, text });
    }
    return text;
  };
  const add = (map: Record<string, ProjectUsage[]>, id: string | undefined, use: ProjectUsage) => {
    if (id) (map[id] ??= []).push(use);
  };
  const readJson = async (rel: string): Promise<any> => {
    try { return JSON.parse(await read(rel)); }
    catch (e) { out.complete = false; out.diagnostics.push(`Could not inspect ${rel}: ${String(e)}`); return null; }
  };
  const manifest = await readJson("project.json");
  const index = await readJson("fig/index.json");
  const canonicalFigures = new Map<string, { referenceKey?: string; panels: string[] }>();
  for (const c of index?.canvases ?? []) {
    const path = `fig/canvases/${c.id}.json`;
    const canvas = await readJson(path);
    for (const f of canvas?.figures ?? []) {
      canonicalFigures.set(f.id, { referenceKey: f.referenceKey, panels: panelLetters(f) });
      for (const el of f.elements ?? []) {
      add(out.byAsset, el.assetId, { kind: "figure", path, figureId: f.id, elementId: el.id, label: f.nickname || f.name || f.id });
      }
    }
  }
  const docs = new Set<string>([manifest?.manuscript?.path, ...(manifest?.supplementary ?? []).map((d: any) => d.path)].filter(Boolean));
  const decks = new Map<string, string>((manifest?.slides ?? []).map((d: any) => [d.id, d.path || `slides/${d.id}/deck.json`]));
  const walk = async (rel: string, depth = 0): Promise<void> => {
    if (!io.readdir || depth > 20) return;
    let entries: { name: string; dir: boolean }[];
    try { entries = await io.readdir(`${root}/${rel}`); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.includes(".sync-conflict-")) continue;
      if (rel === "Context" && (e.name === "Transcripts" || e.name === "Dispatches")) continue;
      const path = `${rel}/${e.name}`;
      if (e.dir) await walk(path, depth + 1);
      else if (/\.(qmd|md)$/i.test(e.name) && !rel.startsWith("slides/")) docs.add(path);
      else if (e.name === "deck.json" && rel.startsWith("slides/")) decks.set(rel.split("/")[1], path);
    }
  };
  await Promise.all([walk("manuscript"), walk("Context"), walk("supplementary"), walk("slides")]);
  const labels = (index?.figures ?? []).map((f: any) => ({ id: f.id, label: canonicalFigures.get(f.id)?.referenceKey ?? f.label, panels: canonicalFigures.get(f.id)?.panels }));
  const resolve = createFigureReferenceResolver<{ id: string; label: string; panels?: string[] }>(labels);
  for (const path of docs) {
    let text: string;
    try { text = await read(path); } catch { out.complete = false; out.diagnostics.push(`Could not inspect ${path}`); continue; }
    const tokens = new Set(figureReferenceTokens(text).map((t) => t.token));
    for (const token of tokens) {
      const f = resolve(token)?.ref;
      if (f) add(out.byFigure, f.id, { kind: "manuscript", path, figureId: f.id, label: path });
    }
  }
  for (const [deckId, path] of decks) {
    const d = await readJson(path);
    for (const s of d?.slides ?? []) {
      const use = { kind: "slide" as const, path, deckId, slideId: s.id, label: `${d.title || deckId} · ${s.name || s.id}` };
      for (const e of s.elements ?? []) add(out.byAsset, e.assetId, { ...use, elementId: e.id });
      for (const beat of s.beats ?? []) for (const t of beat.tracks ?? []) add(out.byAsset, t.to?.assetId, { ...use, elementId: t.target?.elementId, trackId: t.id });
    }
  }
  for (const uses of Object.values(out.byAsset)) {
    for (const f of uses.filter((u) => u.kind === "figure")) for (const s of uses.filter((u) => u.kind === "slide")) {
      const list = out.byFigure[f.figureId!] ??= [];
      if (!list.some((u) => u.path === s.path && u.slideId === s.slideId)) list.push(s);
    }
  }
  return out;
}
