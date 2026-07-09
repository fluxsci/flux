import type { Element, Figure, ImageElement } from "./types";
import { arrowHeads, elementBBox } from "./geometry";
import { buildRenderTree, effectiveHidden, type RenderNode } from "./groups";
import { visualLines, lineH } from "./text";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Wrap markup with the element's rotation + flip about its centre. (Named `rot`
// for history; it now also handles flipX/flipY so callers stay unchanged.)
function rot(e: Element, inner: string): string {
  const sx = e.flipX ? -1 : 1;
  const sy = e.flipY ? -1 : 1;
  if (!e.rotation && sx === 1 && sy === 1) return inner;
  // FIG-2: pivot on the true bbox centre so a rotated/flipped line/arrow (width/height 0)
  // swings about its centre, matching the on-canvas Element.svelte transform.
  const bb = elementBBox(e);
  const cx = bb.x + bb.w / 2;
  const cy = bb.y + bb.h / 2;
  const parts: string[] = [];
  if (e.rotation) parts.push(`rotate(${e.rotation} ${cx} ${cy})`);
  if (sx !== 1 || sy !== 1)
    parts.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
  return `<g transform="${parts.join(" ")}">${inner}</g>`;
}

function op(e: Element): string {
  return e.opacity != null && e.opacity < 1 ? ` opacity="${e.opacity}"` : "";
}

/** Intrinsic content size (assetDisplaySize units) for crop rendering of
 *  `<image>`-backed elements. Callers wire it to ops.assetDisplaySize (GUI) or
 *  the fig index's asset dims (flux-core). Optional — without it a cropped
 *  raster degrades to the uncropped full image. */
export type AssetSizeFn = (id: string) => { width: number; height: number } | undefined | null;

// A cropped `<image>` element: nested-svg viewport — viewBox = the crop window
// (intrinsic px), the image drawn at full display size inside it. Same window
// semantics as the inline plot's viewBox sub-rect (cropViewBoxValue).
function croppedImage(
  e: Element & { type: "image" | "plot"; crop: NonNullable<ImageElement["crop"]> },
  href: string,
  disp: { width: number; height: number },
): string {
  return (
    `<svg x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
    `viewBox="${e.crop.x} ${e.crop.y} ${e.crop.width} ${e.crop.height}" ` +
    `preserveAspectRatio="none" overflow="hidden"${op(e)}>` +
    `<image x="0" y="0" width="${disp.width}" height="${disp.height}" ` +
    `preserveAspectRatio="none" href="${href}"/></svg>`
  );
}

// Serialize a single element to SVG markup in figure-local coordinates.
export function elementToSvg(
  e: Element,
  assetUrl: (id: string) => string | undefined,
  plotMarkup?: (e: Element) => string | undefined,
  assetSize?: AssetSizeFn,
): string {
  switch (e.type) {
    case "plot": {
      // Inline the semantic subtree (overrides applied, ids prefixed) so the
      // exported figure stays addressable/editable. Fall back to <image>.
      const markup = plotMarkup?.(e);
      if (markup) return rot(e, markup);
      const href = assetUrl(e.assetId);
      if (!href) return "";
      const disp = e.crop ? assetSize?.(e.assetId) : undefined;
      if (e.crop && disp)
        return rot(e, croppedImage(e as Element & { type: "plot"; crop: NonNullable<typeof e.crop> }, href, disp));
      return rot(
        e,
        `<image x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `preserveAspectRatio="none" href="${href}"${op(e)}/>`,
      );
    }
    case "image": {
      const href = assetUrl(e.assetId);
      if (!href) return "";
      const disp = e.crop ? assetSize?.(e.assetId) : undefined;
      if (e.crop && disp)
        return rot(e, croppedImage(e as Element & { type: "image"; crop: NonNullable<typeof e.crop> }, href, disp));
      return rot(
        e,
        `<image x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `preserveAspectRatio="none" href="${href}"${op(e)}/>`,
      );
    }
    case "rect":
      return rot(
        e,
        `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `rx="${e.cornerRadius}" fill="${e.fill}" stroke="${e.stroke}" ` +
          `stroke-width="${e.strokeWidth}"${op(e)}/>`,
      );
    case "ellipse":
      return rot(
        e,
        `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" ` +
          `rx="${e.width / 2}" ry="${e.height / 2}" fill="${e.fill}" ` +
          `stroke="${e.stroke}" stroke-width="${e.strokeWidth}"${op(e)}/>`,
      );
    case "line": {
      const x1 = e.x + e.x1;
      const y1 = e.y + e.y1;
      const x2 = e.x + e.x2;
      const y2 = e.y + e.y2;
      let s =
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
        `stroke="${e.stroke}" stroke-width="${e.strokeWidth}" ` +
        `stroke-linecap="round"/>`;
      for (const tri of arrowHeads(e)) {
        const pts = tri.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ");
        s += `<polygon points="${pts}" fill="${e.stroke}"/>`;
      }
      return rot(e, s);
    }
    case "path":
      return rot(
        e,
        `<path d="${e.d}" fill="${e.closed ? e.fill : "none"}" ` +
          `stroke="${e.stroke}" stroke-width="${e.strokeWidth}" ` +
          `stroke-linejoin="round" stroke-linecap="round"${op(e)} ` +
          `transform="translate(${e.x} ${e.y})"/>`,
      );
    case "text": {
      // visualLines = the GUI's wrap cache when present (sizing auto-h/fixed),
      // else the hard lines — this ONE function also serves flux-core's
      // headless renderFigureSvg, so wrapped output is identical everywhere.
      const lines = visualLines(e);
      const anchor =
        e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
      const ax =
        e.align === "center"
          ? e.x + e.width / 2
          : e.align === "right"
            ? e.x + e.width
            : e.x;
      const style =
        e.fontStyle === "italic" ? ` font-style="italic"` : "";
      const deco = e.underline ? ` text-decoration="underline"` : "";
      const tspans = lines
        .map(
          (ln, i) =>
            `<tspan x="${ax}" dy="${i === 0 ? 0 : lineH(e)}">${esc(ln)}</tspan>`,
        )
        .join("");
      return rot(
        e,
        `<text x="${ax}" y="${e.y + e.fontSize}" font-family="${esc(e.fontFamily)}" ` +
          `font-size="${e.fontSize}" font-weight="${e.fontWeight}"${style}${deco} ` +
          `fill="${e.color}" text-anchor="${anchor}"${op(e)}>${tspans}</text>`,
      );
    }
  }
}

// Serialize a whole figure to a standalone, self-contained SVG document.
// P9: iterates the derived render tree (groups.ts buildRenderTree — z-ordered,
// straggler/dangling tolerant) so every registered group becomes a real nested
// `<g data-flux-group="<name>" id="<figId>__group:<gid>">` wrapper around its
// members (nested groups nest). Element markup and paint order are UNCHANGED —
// an ungrouped figure's output is byte-identical to the old flat render (the
// tree degenerates to the same element sequence). The wrappers are the slides
// handshake: a deck Track {target: <embedFigureEl>, part: "group:<gid>"}
// resolves to this node inside the mounted figure svg (player.ts resolveNodes),
// so any figure group is animatable from Flux Slide. flux-core renderFigureSvg
// and gatherDeckPayload reuse this one function and inherit the wrappers.
export function figureToSvg(
  fig: Figure,
  assetUrl: (id: string) => string | undefined,
  plotMarkup?: (e: Element) => string | undefined,
  assetSize?: AssetSizeFn,
): string {
  const nodeToSvg = (n: RenderNode): string => {
    if (n.kind === "element")
      // Layers eyes: an element hidden itself OR by any ancestor GROUP's eye
      // (P7 registry, groups.ts) is omitted from export. effectiveHidden (not
      // just the walk's group skip) also covers stragglers/dangling ids the
      // tree renders LOOSE outside their (hidden) group's wrapper.
      return effectiveHidden(fig, n.el) ? "" : elementToSvg(n.el, assetUrl, plotMarkup, assetSize);
    if (n.def.hidden) return ""; // hidden group: whole subtree omitted, no empty wrapper
    const inner = n.children.map(nodeToSvg).filter(Boolean).join("\n  ");
    if (!inner) return ""; // every member hidden → no wrapper either
    return (
      `<g data-flux-group="${esc(n.def.name)}" id="${esc(fig.id)}__group:${esc(n.def.id)}">\n  ` +
      `${inner}\n  </g>`
    );
  };
  const body = buildRenderTree(fig).map(nodeToSvg).filter(Boolean).join("\n  ");
  const bg =
    fig.background && fig.background !== "transparent"
      ? `<rect x="0" y="0" width="${fig.width}" height="${fig.height}" fill="${fig.background}"/>\n  `
      : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${fig.width}" height="${fig.height}" ` +
    `viewBox="0 0 ${fig.width} ${fig.height}">\n  ${bg}${body}\n</svg>`
  );
}
