/** Source catch-up for closed decks. No live authoring stores, baseline cache or history. */
import type { Asset } from "../types";
import type { Deck } from "./types";
import { readEmbedDeck, underRoot, type SlidePayloadIO } from "./payload";
import { deckSourceProject, applyDeckSourceUpdates, reconcileDeckExternalAssetSizes } from "./sourceSync";
import { planSourceUpdates, writeSourceUpdates, hasCompleteSvgStructure, type SourceIO } from "../plot/sourceSync";
import { plotSourceCandidates } from "../plot/source";
import { svgIntrinsicSize } from "../plot/svgGeometry";

export async function externalDeckAssetMetadata(root: string, deck: Deck, io: Pick<SourceIO, "exists" | "readText">): Promise<Asset[]> {
  const index = underRoot(root, "fig/index.json");
  const registered: Asset[] = await io.exists(index) ? JSON.parse(await io.readText(index)).assets ?? [] : [];
  const accepted: Asset[] = [];
  for (const asset of registered) if (asset.path && await io.exists(underRoot(root, `fig/${asset.path}`))) accepted.push(asset);
  const known = new Set([...deck.assets, ...registered].map(a => a.id));
  for (const figure of deckSourceProject(deck, { includeExternal: true }).figures) for (const element of figure.elements) {
    if (element.type !== "plot" || !element.source?.svgPath || known.has(element.assetId)) continue;
    for (const candidate of plotSourceCandidates(root, element.source.svgPath, element.source)) {
      try {
        const svg = await io.readText(candidate);
        if (!hasCompleteSvgStructure(svg)) break;
        const size = svgIntrinsicSize(svg);
        accepted.push({ id: element.assetId, name: element.assetId, kind: "svg", path: candidate, naturalWidth: size.w, naturalHeight: size.h });
        known.add(element.assetId); break;
      } catch { /* next supported source location */ }
    }
  }
  return accepted;
}
export async function syncEmbeddedDeckSources(root: string, deckId: string, io: SourceIO & SlidePayloadIO & { writeText(path: string, text: string): Promise<void>; remove?(p: string): Promise<void> }, isCurrent: () => boolean = () => true): Promise<string[]> {
  const baselines = new Map<string, string>();
  const deck = await readEmbedDeck(root, deckId, { ...io, readText: async path => { const text = await io.readText(path); baselines.set(path, text); return text; } });
  const resized = reconcileDeckExternalAssetSizes(deck, await externalDeckAssetMetadata(root, deck, io));
  const model = deckSourceProject(deck);
  const plan = await planSourceUpdates(root, model, io, { assetBase: `slides/${deckId}`, watchProject: deckSourceProject(deck, { includeExternal: true }) });
  const warnings = plan.statuses.filter(s => s.status === "missing" || s.status === "error").map(s => `${s.path}: ${s.detail ?? s.status}; last accepted source retained`);
  if ((!resized && !plan.updates.length) || !isCurrent()) return warnings;
  for (const [path, text] of baselines) if (await io.readText(path) !== text) throw new Error("Deck changed while its sources were checked; retry");
  if (!isCurrent()) return warnings;
  if (plan.updates.length) {
    await writeSourceUpdates(root, plan.updates, io, model, { assetBase: `slides/${deckId}` });
    applyDeckSourceUpdates(deck, plan.updates);
  }
  // Recheck after asset IO as well; another writer's composition always wins.
  for (const [path, text] of baselines) if (await io.readText(path) !== text) throw new Error("Deck changed while sources were accepted; retry");
  if (!isCurrent()) return warnings;
  const manifest = JSON.parse(baselines.get(underRoot(root, "project.json"))!);
  const rel = manifest.slides.find((d: { id: string }) => d.id === deckId).path || `slides/${deckId}/deck.json`;
  deck.modified = new Date().toISOString();
  await io.writeText(underRoot(root, rel), JSON.stringify(deck, null, 2) + "\n");
  return warnings;
}
