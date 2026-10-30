import type { Figure } from "../types";
import { elementAssetRefs } from "../model3d/refs";

/** Bytes needed by image rendering. Model and media payloads never enter this set. */
export function figureImageAssetIds(fig: Pick<Figure, "elements">): Set<string> {
  return new Set(fig.elements.flatMap(element => { const refs = elementAssetRefs(element); return [...refs.images, ...refs.posterRefs]; }));
}

