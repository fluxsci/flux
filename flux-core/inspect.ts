// Read current target state from saved project files; never render to inspect.
import * as fs from "node:fs/promises";
import { parseTarget, formatTarget, describeTarget, type TargetRef } from "../src/lib/project/targets";
import { toPacket, type InboxItem } from "../src/lib/project/inbox";
import { buildPartIndex } from "../src/lib/plot/parse";
import { trackDuration } from "../src/lib/slide/compile";
import type { FluxPlotManifest, PartNode } from "../src/lib/plot/types";
import { loadFigModel, projectAssetPath } from "./model";
import { loadDeck, compileDeckSlide } from "./slides";
import { loadLibrary } from "./fluxlib";
import { readFulltext } from "./items";
import { loadAnnotations } from "./annotate";
import { readInbox, findInboxItem } from "./annotations";
import { ValidationError } from "./errors";
import type { McpContent, McpRender } from "./registry";

export async function inspectTarget(root: string, input: string | TargetRef): Promise<Record<string, unknown>> {
  let target: TargetRef;
  try {
    const raw = typeof input === "string" ? input.trim().startsWith("{") ? JSON.parse(input) : parseTarget(input) : input;
    // Validate structured input with the same shorthand grammar; retain display context.
    target = { ...raw, ...parseTarget(formatTarget(raw)) };
  } catch (e) { throw new ValidationError(`invalid target: ${(e as Error).message}`); }
  const result = { target, description: describeTarget(target) };
  switch (target.kind) {
    case "figure": case "element": case "part": case "caption": {
      const { project } = await loadFigModel(root);
      const figure = project.figures.find(f => f.id === target.figureId);
      if (!figure) throw new ValidationError(`figure not found: ${target.figureId}`);
      const summary = { id: figure.id, name: figure.name, nickname: figure.nickname, referenceKey: figure.referenceKey, canvasId: figure.canvasId };
      if (target.kind === "figure") return { ...result, figure: summary, elements: figure.elements.map(e => ({ id: e.id, type: e.type, name: e.name })), groups: figure.groups, captions: figure.captions };
      if (target.kind === "caption") return { ...result, figure: summary, caption: target.panel ? figure.captions?.[target.panel] : figure.captions };
      const element = figure.elements.find(e => e.id === target.elementId);
      if (!element) {
        const group = figure.groups?.[target.elementId];
        if (target.kind === "element" && group) return { ...result, figure: summary, group };
        throw new ValidationError(`element not found: ${target.elementId}`);
      }
      if (target.kind === "element") return { ...result, figure: summary, element };
      const plot = element as typeof element & { assetId?: string; source?: { manifestPath?: string }; overrides?: Record<string, unknown> };
      let manifest: FluxPlotManifest | undefined;
      for (const rel of [plot.assetId ? `fig/assets/${plot.assetId}.fluxplot.json` : null, plot.source?.manifestPath]) {
        if (!rel) continue;
        try { manifest = JSON.parse(await fs.readFile(await projectAssetPath(root, rel), "utf8")); break; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      const find = (node?: PartNode): PartNode | undefined => node?.id === target.partId ? node : node?.children?.map(find).find(Boolean);
      const part = manifest ? buildPartIndex(manifest)[target.partId] ?? find(manifest.parts) : undefined;
      if (!part) throw new ValidationError(`plot part not found: ${target.partId}`);
      return { ...result, figure: summary, element: { id: element.id, type: element.type, name: element.name }, part, override: plot.overrides?.[target.partId] };
    }
    case "doc": {
      const text = await fs.readFile(await projectAssetPath(root, target.path), "utf8");
      const from = Math.min(target.from, text.length), to = Math.min(target.to, text.length);
      const heading = [...text.slice(0, from).matchAll(/^#{1,6}\s+(.+)$/gm)].at(-1)?.[1] ?? null;
      return { ...result, path: target.path, from, to, quote: text.slice(from, to), heading, around: text.slice(Math.max(0, from - 400), Math.min(text.length, to + 400)) };
    }
    case "slide": case "beat": case "track": {
      const deck = await loadDeck(root, target.deckId), slide = deck.slides.find(s => s.id === target.slideId);
      if (!slide) throw new ValidationError(`slide not found: ${target.slideId}`);
      const summary = { id: slide.id, name: slide.name, index: deck.slides.indexOf(slide), deckId: deck.id, deckTitle: deck.title };
      const compiled = await compileDeckSlide(root, deck, slide.id);
      const beats = slide.beats.map((b, index) => ({ ...b, index, duration: compiled.cues[index].duration, tracks: compiled.resolvedSlide.beats[index].tracks }));
      if (target.kind === "slide") return { ...result, slide: summary, beats, elements: slide.elements.map(e => ({ id: e.id, type: e.type, name: e.name })) };
      if (target.kind === "beat") {
        const beat = beats[target.beat];
        if (!beat) throw new ValidationError(`step not found: ${target.beat}`);
        return { ...result, slide: summary, beat };
      }
      for (const beat of beats) {
        const track = beat.tracks.find(t => t.id === target.trackId);
        if (!track) continue;
        // The published shape stays {start, duration, end}; an anchored track adds `anchored`.
        // A track the compiler skips (disabled, dangling target) still has a numeric end.
        const start = track.start ?? 0, duration = trackDuration(track);
        const end = compiled.cues[beat.index].tracks.find(t => t.track.id === track.id)?.end ?? start + duration;
        return { ...result, slide: summary, beat: { index: beat.index, label: beat.label }, track, timing: { start, duration, end, ...(track.anchor ? { anchored: true } : {}) } };
      }
      throw new ValidationError(`track not found: ${target.trackId}`);
    }
    case "library-item": case "passage": {
      const entry = (await loadLibrary()).find(e => e.key === target.citekey);
      if (!entry) throw new ValidationError(`reference not found: ${target.citekey}`);
      if (target.kind === "library-item") return { ...result, entry };
      const [fulltext, annotations] = await Promise.all([readFulltext(target.citekey), loadAnnotations(target.citekey)]);
      const highlight = target.highlightId ? annotations.annotations.find(a => a.id === target.highlightId) : undefined;
      return { ...result, citekey: target.citekey, title: entry.title, page: target.page,
        text: fulltext?.split(/\f/)[target.page - 1]?.trim() ?? null, quote: highlight?.anchor.quote ?? target.quote ?? null, highlight };
    }
    case "region": return { ...result, region: target.rect, surface: target.surface };
  }
}

/** Missing/deleted targets stay visible as an explicit packet error. */
export async function inboxPackets(root: string, items: readonly InboxItem[]) {
  return Promise.all(items.map(async item => {
    const targets = await Promise.all(item.targets.map(async target => {
      try { return await inspectTarget(root, target); }
      catch (e) { return { target, error: (e as Error).message }; }
    }));
    return toPacket(item, { targets });
  }));
}

/** Annotation snapshots are PNGs. Resizing uses the existing isolated raster worker. */
export async function getInboxImage(root: string, id: string): Promise<McpContent> {
  const item = findInboxItem((await readInbox(root)).items, id);
  if (!item.image) throw new ValidationError(`${id} has no snapshot image`);
  const file = await projectAssetPath(root, item.image);
  let png: Buffer = await fs.readFile(file);
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ValidationError(`${id}: snapshot is not a PNG`);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width * height > 100_000_000) throw new ValidationError(`${id}: invalid snapshot dimensions`);
  if (Math.max(width, height) > 1600) {
    const w = Math.max(1, Math.floor(width * 1600 / Math.max(width, height)));
    const h = Math.max(1, Math.floor(height * 1600 / Math.max(width, height)));
    const { rasterizeSvgToPng } = await import("./render");
    png = await rasterizeSvgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${png.toString("base64")}"/></svg>`, w);
  }
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}
export async function packetResponse(root: string, items: readonly InboxItem[], extra: Record<string, unknown> = {}): Promise<McpRender> {
  const packets = await inboxPackets(root, items);
  const content: McpContent[] = [{ type: "text", text: JSON.stringify({ ...extra, items: packets }, null, 2) }];
  let images = 0;
  for (const item of items) {
    if (!item.image) continue;
    if (images >= 6) { content.push({ type: "text", text: `${item.id}: ${item.image}. Fetch it with flux_verb {verb:"get_inbox_image", args:{id:${JSON.stringify(item.id)}}}.` }); continue; }
    try {
      const image = await getInboxImage(root, item.id);
      content.push({ type: "text", text: `Snapshot for ${item.id}` }, image); images++;
    } catch (e) { content.push({ type: "text", text: `${item.id}: snapshot unavailable (${(e as Error).message}); path: ${item.image}` }); }
  }
  return { content };
}
