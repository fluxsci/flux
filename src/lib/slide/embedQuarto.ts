import { scanSlideEmbeds, serializeSlideEmbed, posterPath } from "./embed";
import { relativeDocumentPath } from "../project/documentFiles";
import { prepareSlideDocument, slideDocumentBundle, finishSlideDocument, type SlideDocumentBundle } from "./embedDocument";
import type { SlideRepository } from "./embedRepository";
/** Shared Quarto adapter: ordinary image in static formats; raw HTML with one runtime in HTML. */
export async function prepareSlideQuarto(text: string, file: string, root: string, repo: SlideRepository, interactive: boolean, bundle?: SlideDocumentBundle, signal?: AbortSignal): Promise<string> {
  if (!scanSlideEmbeds(text).length) return text;
  if (interactive) {
    const result = await prepareSlideDocument(text, repo, { interactive: true, strict: true, bundle, signal });
    let next = result.text;
    for (const block of result.blocks) next = next.replace(block.token, `\n\n\x60\x60\x60{=html}\n${block.html}\n\x60\x60\x60\n\n`);
    return next + `\n\n\x60\x60\x60{=html}\n${result.style}${result.tail}\n\x60\x60\x60\n`;
  }
  const rel = file.replace(/\\/g, "/").slice(root.replace(/\\/g, "/").replace(/\/$/, "").length + 1);
  const spans = scanSlideEmbeds(text);
  for (const span of [...spans].reverse()) {
    signal?.throwIfAborted();
    await repo.materialize(span.ref);
    const ref = { ...span.ref, path: relativeDocumentPath(rel, posterPath(span.ref.deck, span.ref.slide)) };
    text = text.slice(0, span.from) + serializeSlideEmbed(ref) + text.slice(span.to);
  }
  return text;
}

/** One bundle/runtime across the entry and every included fragment. */
export function slideQuartoTransform(root: string, repo: SlideRepository, interactive: boolean) {
  const bundle = slideDocumentBundle();
  return {
    transformSlides: (text: string, file: string) => prepareSlideQuarto(text, file, root, repo, interactive, bundle),
    async finishSlides(text: string) {
      if (!interactive || !bundle.count) return text;
      const { style, tail } = await finishSlideDocument(bundle, { interactive });
      return `${text}\n\n\x60\x60\x60{=html}\n${style}${tail}\n\x60\x60\x60\n`;
    },
  };
}
