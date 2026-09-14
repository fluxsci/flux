import { scanSlideEmbeds, embedKey } from "./embed";
import type { SlideRepository } from "./embedRepository";
import type { ExportPayload } from "./payload";
import { SLIDE_EMBED_CSS } from "./embedPlayer";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export interface SlideDocumentBundle { payloads: Record<string, ExportPayload>; occurrences: { id: string; source: string }[]; ids: Set<string>; count: number }
export const slideDocumentBundle = (): SlideDocumentBundle => ({ payloads: {}, occurrences: [], ids: new Set(), count: 0 });
export interface SlideDocumentOptions { interactive: boolean; live?: boolean; documentKey?: string; strict?: boolean; bundle?: SlideDocumentBundle; signal?: AbortSignal }
export async function prepareSlideDocument(src: string, repository: SlideRepository | null | undefined, opts: SlideDocumentOptions) {
  const spans = scanSlideEmbeds(src), blocks: { token: string; html: string }[] = [];
  const bundle = opts.bundle ?? slideDocumentBundle();
  const { payloads, occurrences, ids } = bundle;
  let text = src;
  for (const span of spans) {
    opts.signal?.throwIfAborted();
    const r = span.ref, source = embedKey(r);
    const index = ++bundle.count, token = `FLUXSLIDEBLOCK${index}X`;
    let id = r.id || `slide-${index}`; while (ids.has(id)) id += `-${index}`; ids.add(id);
    let width = r.width ? /^\d+(\.\d+)?$/.test(r.width) ? `${r.width}px` : r.width : "100%";
    let art: string;
    try {
      if (!repository) throw new Error("Open the source project to render this slide");
      const snapshot = opts.strict ? await repository.materialize(r, { portable: opts.interactive && !payloads[source] }) : await repository.load(r);
      if (!r.width) width = `${snapshot.payload.deck.stage.width}px`;
      const poster = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshot.poster)}`;
      art = `<img class="flux-slide-poster" src="${esc(poster)}" alt="${esc(r.caption || snapshot.payload.deck.slides[0].name || "Slide")}" style="aspect-ratio:${snapshot.payload.deck.stage.width}/${snapshot.payload.deck.stage.height}"/>`;
      if (opts.interactive) { payloads[source] ??= snapshot.payload; occurrences.push({ id, source }); art += '<div class="flux-slide-live"></div>'; }
      art += `<div class="flux-slide-static-title">${esc(snapshot.payload.deck.title)} · ${esc(snapshot.payload.deck.slides[0].name || "Slide")} · Step 0</div>`;
    } catch (e) { if (opts.strict) throw e; art = `<div class="flux-slide-error">Slide unavailable: ${esc(String((e as Error).message || e))}</div>`; }
    blocks.push({ token, html: `<figure class="flux-slide-embed" id="${esc(id)}" style="width:${esc(width)}">${art}${r.caption ? `<figcaption class="flux-slide-caption">${esc(r.caption)}</figcaption>` : ""}</figure>` });
  }
  for (let i = spans.length - 1; i >= 0; i--) text = text.slice(0, spans[i].from) + blocks[i].token + text.slice(spans[i].to);
  opts.signal?.throwIfAborted();
  const { style, tail } = opts.bundle ? { style: "", tail: "" } : await finishSlideDocument(bundle, opts);
  return { text, blocks, style, tail };
}
export async function finishSlideDocument(bundle: SlideDocumentBundle, opts: SlideDocumentOptions) {
  const { payloads, occurrences } = bundle;
  let tail = "", style = "";
  if (bundle.count) {
    const assets = (await import("../../../.generated/slide-embed-assets.json")).default;
    style = `<style>${SLIDE_EMBED_CSS}.flux-slide-poster{display:block}.flux-slide-enhanced>.flux-slide-poster,.flux-slide-enhanced>.flux-slide-static-title{display:none}.flux-slide-static-title{font:12px system-ui,sans-serif;padding:7px 0}@media print{.flux-slide-live{display:none!important}.flux-slide-poster,.flux-slide-static-title{display:block!important}}</style><style>${assets.fonts}</style>`;
    if (opts.interactive && occurrences.length) {
      const data = JSON.stringify({ live: !!opts.live, documentKey: opts.documentKey || "", payloads, occurrences }).replace(/</g, "\\u003c");
      tail = `<script type="application/json" id="flux-slide-data">${data}</script><script>${assets.runtime}</script>`;
    }
  }
  return { style, tail };
}
