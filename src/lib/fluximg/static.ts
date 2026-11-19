/**
 * A placed fluximg's complete static markup: the element at rest, in exports and in Paper.
 *
 * A still (a PNG data URL rendered by the reference renderer at the pixels needed) plus everything vector:
 * layers, object names, furniture. All of it sits in one nested `<svg>` the size of the element's box with
 * `overflow="hidden"`, which clips identically in Chromium and resvg. Pure string building.
 */
import type { FluximgManifest } from "./types";
import type { PixelRect, ResolvedView } from "./view";
import { furnitureSvg } from "./furniture";
import { escapeXml, layerMarkup, namesMarkup, objectIndex, svgNum } from "./layers";

export interface FluximgStaticInput {
  manifest: FluximgManifest;
  view: ResolvedView;
  /** Visible rectangle in level-0 image pixels. */
  crop: PixelRect;
  /** Element size in canvas px. */
  box: { width: number; height: number };
  /** The still as a data URL; null = not rendered yet (a neutral placeholder is drawn). */
  stillHref: string | null;
  /** Layer id → that layer's SVG text (vector layers and label outlines). A missing entry is skipped. */
  layerSvg: Record<string, string>;
  idPrefix: string;
}

/** Drawn while the still is not available yet. */
export const PLACEHOLDER_FILL = "#2b2a28";

export function fluximgStaticSvg(input: FluximgStaticInput): string {
  const { manifest, view, crop, box, stillHref, layerSvg, idPrefix } = input;
  const w = svgNum(box.width), h = svgNum(box.height);
  const out: string[] = [`<svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">`];
  if (view.background && view.background !== "transparent") {
    out.push(`<rect id="${escapeXml(idPrefix + "background")}" x="0" y="0" width="${w}" height="${h}" fill="${escapeXml(view.background)}"/>`);
  }
  if (stillHref) out.push(`<image id="${escapeXml(idPrefix + "still")}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${escapeXml(stillHref)}"/>`);
  else out.push(`<rect id="${escapeXml(idPrefix + "placeholder")}" x="0" y="0" width="${w}" height="${h}" fill="${PLACEHOLDER_FILL}"/>`);

  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  for (const lv of view.layers) {
    const layer = byId.get(lv.id), text = layerSvg[lv.id];
    if (!layer || text === undefined || layer.kind === "intensity") continue;
    out.push(layerMarkup(layer, text, lv, crop, box, idPrefix));
  }

  const names = view.furniture.names;
  if (names) {
    for (const id of names.layers) {
      const layer = byId.get(id), lv = view.layers.find((l) => l.id === id), text = layerSvg[id];
      if (!layer || !lv || !lv.visible || text === undefined || layer.kind === "intensity") continue;
      out.push(namesMarkup(objectIndex(text), null, crop, box, { layerId: id, fontSize: names.fontSize, color: lv.color ?? layer.color ?? "#ffffff" }, idPrefix));
    }
  }

  out.push(furnitureSvg(manifest, view, crop, box, idPrefix));
  out.push("</svg>");
  return out.join("");
}

/**
 * A child element's crop drawn on its parent (an inset's blow-out source): a dashed rectangle in the parent's
 * box. `idPrefix` should name the child, since a parent can carry several. "" when the child's crop is wholly
 * outside the parent's.
 */
export function insetRectMarkup(childCrop: PixelRect, parentCrop: PixelRect, box: { width: number; height: number }, idPrefix: string, color = "#ffffff"): string {
  if (!(parentCrop.width > 0 && parentCrop.height > 0)) return "";
  const sx = box.width / parentCrop.width, sy = box.height / parentCrop.height;
  const x0 = (childCrop.x - parentCrop.x) * sx, y0 = (childCrop.y - parentCrop.y) * sy;
  const x1 = x0 + childCrop.width * sx, y1 = y0 + childCrop.height * sy;
  if (x1 < 0 || y1 < 0 || x0 > box.width || y0 > box.height) return "";
  return `<rect id="${escapeXml(idPrefix + "inset")}" data-part="inset" x="${svgNum(x0)}" y="${svgNum(y0)}" width="${svgNum(x1 - x0)}" height="${svgNum(y1 - y0)}" fill="none" stroke="${escapeXml(color)}" stroke-width="1" stroke-dasharray="4 3"/>`;
}
