// Shared disposable data for Node and real-renderer source ownership gates.
import { createDeck } from "../../src/lib/slide/ops";
import { executeFigSave, planFigSave } from "../../src/lib/project/figfiles";
import type { Project, SemanticPlotElement } from "../../src/lib/types";
export const orphanSvg = (version: number, width = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="100" data-version="${version}"><rect width="${width}" height="100" fill="#4385be"/></svg>`;
export const orphanManifest = (version: number) => JSON.stringify({ spec: "fluxplot", schemaVersion: "0.2.0", axes: [], series: [], version });
export async function writeOrphanSourcesFixture(io: { write(rel: string, text: string): Promise<unknown>; read(rel: string): Promise<string | null> }) {
  const ids = ["orphan-live", "orphan-frozen", "orphan-target"];
  const plot = (id: string, x = 20): SemanticPlotElement => ({ id, type: "plot", assetId: id, x, y: 30, width: 100, height: 50, rotation: 0,
    source: { svgPath: `plots/${id}.svg`, ...(id === "orphan-frozen" ? { frozen: true } : {}) } });
  const project: Project = { version: 2, name: "Deck source owners", canvases: [{ id: "orphan-canvas", name: "Source canvas" }],
    figures: [{ id: "orphan-origin", name: "Figure 1", referenceKey: "fig-orphan-origin", canvasId: "orphan-canvas", x: 0, y: 0,
      width: 500, height: 200, background: "#ffffff", elements: ids.map((id, i) => plot(id, 20 + i * 130)) }],
    assets: ids.map((id) => ({ id, name: `${id}.svg`, kind: "svg", path: `assets/${id}.svg`, naturalWidth: 200, naturalHeight: 100 })), palette: [] };
  const deck = createDeck({ id: "orphan-talk", title: "Deck source owners", withTitleSlide: false });
  deck.externalAssetSizes = Object.fromEntries(ids.map((id) => [id, { width: 200, height: 100 }]));
  deck.slides = [{ id: "orphan-slide", name: "Retained source", camera: { x: 300, y: 200, zoom: 1.2 },
    elements: [plot("orphan-live"), plot("orphan-frozen", 180)], beats: [{ id: "base", tracks: [] }, { id: "change", tracks: [
      { id: "orphan-morph", target: "orphan-live", preset: "transform", duration: 900, to: { assetId: "orphan-target", svgPath: "plots/orphan-target.svg", state: { x: 450, width: 123 } } },
    ] }] }];
  await io.write("project.json", JSON.stringify({ schemaVersion: "0.1.0", title: deck.title, manuscript: { path: "manuscript/main.qmd" }, supplementary: [], figures: [], slides: [{ id: deck.id, path: `slides/${deck.id}/deck.json`, title: deck.title }] }));
  await io.write("manuscript/main.qmd", "# Results\n\nThe saved deck retains its own source links.\n");
  await executeFigSave(planFigSave(project, null), { read: io.read, write: async (rel, text) => { await io.write(rel, text); } });
  await io.write(`slides/${deck.id}/deck.json`, JSON.stringify(deck));
  for (const id of ids) for (const base of ["plots", "fig/assets"]) {
    await io.write(`${base}/${id}.svg`, orphanSvg(1));
    await io.write(`${base}/${id}.fluxplot.json`, orphanManifest(1));
  }
  return { project, deck, ids };
}
