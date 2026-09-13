// Read-only usage index. Include decks and animation-only targets before GC.
import { createFigureReferenceResolver } from "../figureReferences";
import { discoverDocuments, type DocumentIO } from "./documentFiles";
import { scanSlideEmbeds, embedKey } from "../slide/embed";
import { readQmdTree } from "../exportQmd";
import { underRoot } from "../slide/payload";
import { panelLetters } from "../captions";
import { figureReferenceTokens } from "./figureReferenceEdits";
export interface DependencyIO {
  exists?(path: string): Promise<boolean>;
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
  byDeck: Record<string, ProjectUsage[]>;
  bySlide: Record<string, ProjectUsage[]>;
  byFigure: Record<string, ProjectUsage[]>;
  byAsset: Record<string, ProjectUsage[]>;
  diagnostics: string[];
  complete: boolean;
}
const textCache = new Map<string, { signature: string; text: string }>();
export async function readProjectDependencies(root: string, io: DependencyIO, liveDocuments: readonly { path: string; text: string }[] = []): Promise<ProjectDependencies> {
  const out: ProjectDependencies = { byDeck: {}, bySlide: {}, byFigure: {}, byAsset: {}, diagnostics: [], complete: true };
  const live = new Map(liveDocuments.map(d => [d.path.startsWith(root + "/") ? d.path.slice(root.length + 1) : d.path, d.text]));
  const read = async (rel: string): Promise<string> => {
    if (live.has(rel)) return live.get(rel)!;
    const path = underRoot(root, rel);
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
  if (manifest && io.readdir) {
    try {
      const documentIO = {
        read, entries: (rel: string) => io.readdir!(underRoot(root, rel)),
        exists: async (rel: string) => {
          if (live.has(rel)) return true;
          if (io.exists) return io.exists(underRoot(root, rel));
          try { await io.readdir!(underRoot(root, rel)); return true; } catch { try { await read(rel); return true; } catch { return false; } }
        },
      } as DocumentIO;
      for (const d of (await discoverDocuments(manifest, documentIO)).docs) docs.add(d.path);
    } catch (error) { out.complete = false; out.diagnostics.push(`Could not discover documents: ${String(error)}`); }
  }
  for (const rel of live.keys()) docs.add(rel);
  await Promise.all([walk("supplementary"), walk("slides")]);
  const includesSeen = new Set<string>();
  for (const rel of [...docs]) {
    try {
      const tree = await readQmdTree(underRoot(root, rel), { readText: async abs => {
        if (!abs.startsWith(root + "/")) throw new Error("Include is outside project");
        return read(abs.slice(root.length + 1));
      } }, includesSeen);
      for (const abs of tree.files) docs.add(abs.slice(root.length + 1));
    } catch (error) { out.complete = false; out.diagnostics.push(`Could not inspect includes in ${rel}: ${String(error)}`); }
  }
  const labels = (index?.figures ?? []).map((f: any) => ({ id: f.id, label: canonicalFigures.get(f.id)?.referenceKey ?? f.label, panels: canonicalFigures.get(f.id)?.panels }));
  const resolve = createFigureReferenceResolver<{ id: string; label: string; panels?: string[] }>(labels);
  for (const path of docs) {
    let text: string;
    try { text = await read(path); } catch { out.complete = false; out.diagnostics.push(`Could not inspect ${path}`); continue; }
    for (const { ref } of scanSlideEmbeds(text)) {
      const use: ProjectUsage = { kind: "manuscript", path, deckId: ref.deck, slideId: ref.slide, label: path };
      add(out.byDeck, ref.deck, use);
      add(out.bySlide, embedKey(ref), use);
    }
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

export function slideRemovalBlocker(deps: ProjectDependencies, deck: string, slide?: string): string | null {
  if (!deps.complete) return `Document references could not be fully checked. ${deps.diagnostics.join("; ")}`;
  const uses = slide ? deps.bySlide[embedKey({ deck, slide })] : deps.byDeck[deck];
  if (!uses?.length) return null;
  return `Referenced by ${[...new Set(uses.map(u => u.path))].join(", ")}. Removing ${slide ? "this slide" : "this deck"} will leave those documents with unavailable slides.`;
}
