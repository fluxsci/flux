// A fig/assets bundle can outlive its originating Figure because a saved deck
// still uses it. Those deck links become source owners only when no Figure
// placement remains. The returned figures are a read-only planning view: never
// save them or apply their geometry to the real Figure project.
import type { Figure, Project, SemanticPlotElement } from "../types";
import type { Deck } from "../slide/types";

interface SourceOwnerIO {
  readText(path: string): Promise<string>;
  readdir?(path: string): Promise<{ name: string; dir: boolean }[]>;
}
export async function figureSourceOwners(root: string, project: Project, io: SourceOwnerIO): Promise<{
  project: Project;
  deckAssetIds: Set<string>;
  assertUnchanged(): Promise<void>;
}> {
  const placed = new Set(project.figures.flatMap((f) => f.elements.flatMap((e) => "assetId" in e ? [e.assetId] : [])));
  const orphanIds = new Set(project.assets.filter((a) => a.kind === "svg" && a.path && !placed.has(a.id)).map((a) => a.id));
  const deckAssetIds = new Set<string>();
  const baselines = new Map<string, string>();
  const result = (figures: Figure[]) => ({
    project: figures.length ? { ...project, figures: [...project.figures, ...figures] } : project,
    deckAssetIds,
    async assertUnchanged() {
      for (const [path, text] of baselines) if (await io.readText(path) !== text)
        throw new Error("A dependent deck changed while its figure sources were being checked; retry source refresh");
    },
  });
  if (!orphanIds.size) return result([]);

  const manifest = JSON.parse(await io.readText(`${root}/project.json`)) as { slides?: { id: string; path?: string }[] };
  const paths = new Set((manifest.slides ?? []).map((d) => d.path || `slides/${d.id}/deck.json`));
  const scan = async (dir: string, depth = 0): Promise<void> => {
    if (!io.readdir || depth > 20) return;
    let entries: { name: string; dir: boolean }[];
    try { entries = await io.readdir(`${root}/${dir}`); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.includes(".sync-conflict-")) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.dir && !["assets", "renders", "exports"].includes(entry.name)) await scan(path, depth + 1);
      else if (!entry.dir && entry.name === "deck.json") paths.add(path);
    }
  };
  await scan("slides");
  const figures: Figure[] = [];
  for (const rel of paths) {
    // Saved deck paths are project-relative; source paths inside those decks
    // use the separate, explicitly granted external-source resolver.
    if (!rel || /^[\\/]|^[A-Za-z]:/.test(rel) || rel.replaceAll("\\", "/").split("/").includes(".."))
      throw new Error(`Cannot inspect dependent deck outside this project: ${rel}`);
    const path = `${root}/${rel}`;
    let deck: Deck, text: string;
    try { text = await io.readText(path); deck = JSON.parse(text) as Deck; }
    catch { throw new Error(`Cannot inspect dependent deck ${rel}; saved figure sources were retained`); }
    baselines.set(path, text);
    if (!Array.isArray(deck.slides)) throw new Error(`Cannot inspect dependent deck ${rel}: slides are invalid`);
    const local = new Set((deck.assets ?? []).map((a) => a.id));
    for (const slide of deck.slides) {
      const elements: SemanticPlotElement[] = [];
      const add = (element: SemanticPlotElement) => {
        if (!orphanIds.has(element.assetId) || local.has(element.assetId) || !element.source?.svgPath) return;
        elements.push(element); deckAssetIds.add(element.assetId);
      };
      for (const element of slide.elements ?? []) if (element.type === "plot") add(element);
      for (const beat of slide.beats ?? []) for (const track of beat.tracks ?? []) {
        const to = track.to;
        if (!to?.assetId || typeof to.svgPath !== "string") continue;
        const origin = slide.elements?.find((e) => e.id === track.target && e.type === "plot");
        if (origin?.type !== "plot") continue;
        add({ ...origin, id: `source:${track.id}`, assetId: to.assetId, source: {
          svgPath: to.svgPath,
          ...(typeof to.manifestPath === "string" ? { manifestPath: to.manifestPath } : {}),
          ...(typeof to.recipePath === "string" ? { recipePath: to.recipePath } : {}),
          ...(typeof to.external === "boolean" ? { external: to.external } : {}),
          ...(typeof to.frozen === "boolean" ? { frozen: to.frozen } : {}),
        } });
      }
      if (elements.length) figures.push({ id: `deck:${deck.id}:${slide.id}`, name: deck.title || deck.id,
        canvasId: "", x: 0, y: 0, width: 1, height: 1, background: "transparent", elements });
    }
  }
  return result(figures);
}
