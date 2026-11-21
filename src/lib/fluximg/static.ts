/**
 * A placed fluximg's complete static markup: the element at rest, in exports and in Paper.
 *
 * A still (a PNG data URL rendered by the reference renderer at the pixels needed) plus everything vector:
 * layers, object names, furniture. All of it sits in one nested `<svg>` the size of the element's box with
 * `overflow="hidden"`, which clips identically in Chromium and resvg. Pure string building.
 */
import type { FluximgLayer, FluximgManifest, FluximgTable } from "./types";
import type { PixelRect, ResolvedLayer, ResolvedView } from "./view";
import { furnitureSvg } from "./furniture";
import { escapeXml, layerMarkup, namesMarkup, objectIndex, svgNum } from "./layers";
import { cachedObjectStyles, missingStyle, shownObjects, type ObjectLegend, type ObjectStyles } from "./objectStyle";

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
  /** The element is mirrored (by its own transform, outside this markup): words are un-mirrored here. */
  flipX?: boolean;
  flipY?: boolean;
  /** Blow-outs of this element (other elements whose view says `insetOf` this one): each one's crop is outlined here. */
  insets?: Array<{ id: string; crop: PixelRect }>;
  /** Colour-map tables (256 "#rrggbb"), for the calibration bar. Absent: a colour map's bar is drawn gray. */
  resolveLut?: (name: string) => string[] | null;
  /** Layer id → that layer's table: needed by a layer styled by its columns (`styleBy`). A missing one: unstyled. */
  tables?: Record<string, FluximgTable | null | undefined>;
  /** Only what is drawn over the pixels (layers, outlines, names, furniture): no background, no still or placeholder.
   *  An image's movie file draws the pixels itself and lays this over each frame. */
  overlayOnly?: boolean;
}

/** The table file of a label or vector layer, or null. */
export function layerTablePath(layer: FluximgLayer | undefined): string | null {
  if (!layer || layer.kind === "intensity") return null;
  return layer.table || null;
}

/** Whether a resolved layer is drawn styled by its table (it is shown, and asks for a column). */
export const wantsTable = (lv: ResolvedLayer): boolean => lv.visible && lv.kind !== "intensity" && !!lv.styleBy;

const NO_LUT = (): null => null;
/** Styles worth drawing: some part of the request applied (it has a legend). */
export const stylesToDraw = (s: ObjectStyles | null): ObjectStyles | null => (s && s.legend ? s : null);

/** The styles of a layer styled by its table (cached per table and request), or null when it is not styled. */
export function layerStyles(layer: FluximgLayer, lv: ResolvedLayer, table: FluximgTable | null | undefined, resolveLut?: (name: string) => string[] | null): ObjectStyles | null {
  if (!lv.styleBy || layer.kind === "intensity" || !table) return null;
  return cachedObjectStyles(table, layer.key ?? null, lv.styleBy, resolveLut ?? NO_LUT);
}

/** The elements of a figure that are blow-outs of `parentId`, as what the parent needs to outline them. */
export function insetsOf(elements: ReadonlyArray<{ id: string; type: string }>, parentId: string, assetId: string): Array<{ id: string; crop: PixelRect }> {
  const out: Array<{ id: string; crop: PixelRect }> = [];
  for (const el of elements) {
    if (el.type !== "fluximg" || el.id === parentId) continue;
    // Only fluximg elements carry these fields; the figure's element union is wider than this module knows.
    const e = el as { id: string; assetId?: string; crop?: PixelRect; view?: { insetOf?: string } };
    if (e.assetId !== assetId || e.view?.insetOf !== parentId || !e.crop) continue;
    out.push({ id: e.id, crop: { x: e.crop.x, y: e.crop.y, width: e.crop.width, height: e.crop.height } });
  }
  return out;
}

/** The outlines of an element's blow-outs, in its box ("" when it has none in view). */
export function insetsMarkup(insets: ReadonlyArray<{ id: string; crop: PixelRect }> | undefined, crop: PixelRect, box: { width: number; height: number }, idPrefix: string): string {
  if (!insets?.length) return "";
  return insets.map((i) => insetRectMarkup(i.crop, crop, box, `${idPrefix}${i.id.replace(/[^A-Za-z0-9_-]/g, "_")}-`)).join("");
}

/** The id prefix of everything a placed fluximg draws: unique per element, safe in an XML id. */
export function fluximgIdPrefix(elementId: string): string {
  return `fx-${elementId.replace(/[^A-Za-z0-9_-]/g, "_")}-`;
}

/** The SVG file a layer's shapes come from: a label layer's outlines, a vector layer's own file; none for intensity. */
export function layerSvgPath(layer: FluximgLayer | undefined): string | null {
  if (!layer) return null;
  return layer.kind === "labels" ? layer.outlines : layer.kind === "vector" ? layer.path : null;
}

/** The transform that undoes an element's mirror about its box centre ("" when it is not mirrored). */
export function unflipTransform(box: { width: number; height: number }, flipX?: boolean, flipY?: boolean): string {
  if (!flipX && !flipY) return "";
  const cx = svgNum(box.width / 2), cy = svgNum(box.height / 2);
  return `translate(${cx} ${cy}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1}) translate(${svgNum(-box.width / 2)} ${svgNum(-box.height / 2)})`;
}

/** Drawn while the still is not available yet. */
export const PLACEHOLDER_FILL = "#2b2a28";

export function fluximgStaticSvg(input: FluximgStaticInput): string {
  const { manifest, view, crop, box, stillHref, layerSvg, idPrefix } = input;
  const w = svgNum(box.width), h = svgNum(box.height);
  const out: string[] = [`<svg x="0" y="0" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">`];
  // An image's movie draws the pixels (and their background) itself and lays the rest over each frame.
  if (!input.overlayOnly) {
    if (view.background && view.background !== "transparent") {
      out.push(`<rect id="${escapeXml(idPrefix + "background")}" x="0" y="0" width="${w}" height="${h}" fill="${escapeXml(view.background)}"/>`);
    }
    if (stillHref) out.push(`<image id="${escapeXml(idPrefix + "still")}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" href="${escapeXml(stillHref)}"/>`);
    else out.push(`<rect id="${escapeXml(idPrefix + "placeholder")}" x="0" y="0" width="${w}" height="${h}" fill="${PLACEHOLDER_FILL}"/>`);
  }

  const byId = new Map(manifest.layers.map((l) => [l.id, l]));
  const legends: Record<string, ObjectLegend | null> = {};
  const stylesById: Record<string, ObjectStyles> = {};
  for (const lv of view.layers) {
    const layer = byId.get(lv.id), text = layerSvg[lv.id];
    if (!layer || text === undefined || layer.kind === "intensity") continue;
    // Styling that could not apply (a column the table lacks) leaves the layer as it was, never all "missing".
    const styled = stylesToDraw(layerStyles(layer, lv, input.tables?.[lv.id], input.resolveLut));
    if (styled) { legends[lv.id] = styled.legend; stylesById[lv.id] = styled; }
    out.push(layerMarkup(layer, text, lv, crop, box, idPrefix, styled?.byKey, styled ? missingStyle(lv.styleBy) : null));
  }

  out.push(insetsMarkup(input.insets, crop, box, idPrefix));

  const words: string[] = [];
  const names = view.furniture.names;
  if (names) {
    for (const id of names.layers) {
      const layer = byId.get(id), lv = view.layers.find((l) => l.id === id), text = layerSvg[id];
      if (!layer || !lv || !lv.visible || text === undefined || layer.kind === "intensity") continue;
      // An object hidden by its styling (missing: "hide") has no name either.
      const st = stylesById[id];
      words.push(namesMarkup(shownObjects(objectIndex(text), st?.byKey, st ? missingStyle(lv.styleBy) : null), null, crop, box, { layerId: id, fontSize: names.fontSize, color: lv.color ?? layer.color ?? "#ffffff", flipX: input.flipX, flipY: input.flipY }, idPrefix));
    }
  }
  words.push(furnitureSvg(manifest, view, crop, box, idPrefix, input.resolveLut, legends));
  const unflip = unflipTransform(box, input.flipX, input.flipY), text = words.join("");
  out.push(unflip && text ? `<g transform="${unflip}">${text}</g>` : text);
  out.push("</svg>");
  return out.join("");
}

/**
 * A child element's crop drawn on its parent (an inset's blow-out source): a dashed rectangle in the parent's
 * box. `idPrefix` should name the child, since a parent can carry several. "" when the child's crop is wholly
 * outside the parent's.
 */
export function insetRectMarkup(childCrop: PixelRect, parentCrop: PixelRect, box: { width: number; height: number }, idPrefix: string, color = "#ffffff"): string {
  const r = insetRect(childCrop, parentCrop, box);
  if (!r) return "";
  return `<rect id="${escapeXml(idPrefix + "inset")}" data-part="inset" x="${svgNum(r.x)}" y="${svgNum(r.y)}" width="${svgNum(r.width)}" height="${svgNum(r.height)}" fill="none" stroke="${escapeXml(color)}" stroke-width="1" stroke-dasharray="4 3"/>`;
}

/** Where a child's crop lies in its parent's box (box px), or null when it is wholly outside (the slide player moves
 *  its inset rectangles by this as either crop tweens). */
export function insetRect(childCrop: PixelRect, parentCrop: PixelRect, box: { width: number; height: number }): { x: number; y: number; width: number; height: number } | null {
  if (!(parentCrop.width > 0 && parentCrop.height > 0)) return null;
  const sx = box.width / parentCrop.width, sy = box.height / parentCrop.height;
  const x0 = (childCrop.x - parentCrop.x) * sx, y0 = (childCrop.y - parentCrop.y) * sy;
  const x1 = x0 + childCrop.width * sx, y1 = y0 + childCrop.height * sy;
  if (x1 < 0 || y1 < 0 || x0 > box.width || y0 > box.height) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
