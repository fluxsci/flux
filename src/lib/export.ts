import type { Element, Figure } from "./types";
import { arrowHeads, elementBBox } from "./geometry";
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

// Serialize a single element to SVG markup in figure-local coordinates.
export function elementToSvg(
  e: Element,
  assetUrl: (id: string) => string | undefined,
  plotMarkup?: (e: Element) => string | undefined,
): string {
  switch (e.type) {
    case "plot": {
      // Inline the semantic subtree (overrides applied, ids prefixed) so the
      // exported figure stays addressable/editable. Fall back to <image>.
      const markup = plotMarkup?.(e);
      if (markup) return rot(e, markup);
      const href = assetUrl(e.assetId);
      if (!href) return "";
      return rot(
        e,
        `<image x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `preserveAspectRatio="none" href="${href}"${op(e)}/>`,
      );
    }
    case "image":
    case "svg": {
      const href = assetUrl(e.assetId);
      if (!href) return "";
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
export function figureToSvg(
  fig: Figure,
  assetUrl: (id: string) => string | undefined,
  plotMarkup?: (e: Element) => string | undefined,
): string {
  const body = fig.elements
    .filter((e) => !e.hidden) // Layers eye: hidden elements are omitted from export
    .map((e) => elementToSvg(e, assetUrl, plotMarkup))
    .filter(Boolean)
    .join("\n  ");
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
