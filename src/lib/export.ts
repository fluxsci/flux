import { xmlEscape as esc } from "./xml";
import { passivePaint } from "./plot/passiveSvg";
import type { Element, Figure, ImageElement, TextElement } from "./types";
import { lineRender, elementBBox, dashAttr } from "./geometry";
import { pathRender } from "./path";
import { elementPaints, paintDefsSvg } from "./color/gradient";
import { buildRenderTree, effectiveHidden, membersDeep, type RenderNode } from "./groups";
import { lineH, blockLayout, letterSpacing, type LaidOutLine } from "./text";
import { resolvedRunStyle, type TextSegment } from "./textRuns";

// stroke-dasharray attribute (or nothing) — mirrors the canvas dashAttr.
function dashA(e: { dash?: number[] }): string {
  const v = dashAttr(e);
  return v ? ` stroke-dasharray="${v}"` : "";
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

/** One rendered line: its text plus the exact tspan attributes. `textLength` +
 *  `lengthAdjust` are present only on a JUSTIFIED line (never on a paragraph's
 *  last line — the typographic rule; text.ts blockLayout decides). */
export interface TextSpan {
  text: string;
  x: number;
  dy: number;
  textLength?: number;
  /** Present only when per-range formatting touches this line: the pieces to
   *  nest inside the line's own tspan, each carrying whatever differs from the
   *  element. Absent means the line is one plain string, exactly as before. */
  segments?: TextSegment[];
}

/** The attributes a segment needs on top of the element's own — nothing at all
 *  for a piece that already looks like the element, which is what keeps an
 *  unformatted text's SVG byte-identical. */
export function segmentAttrs(e: TextElement, segment: TextSegment): Record<string, string> {
  const style = resolvedRunStyle(e, segment);
  const attrs: Record<string, string> = {};
  if (style.fontWeight !== e.fontWeight) attrs["font-weight"] = String(style.fontWeight);
  if (style.fontStyle !== e.fontStyle) attrs["font-style"] = style.fontStyle;
  if (style.underline !== !!e.underline) attrs["text-decoration"] = style.underline ? "underline" : "none";
  if (segment.color !== undefined && style.color !== undefined && style.color.toLowerCase() !== e.color.toLowerCase()) attrs.fill = passivePaint(style.color);
  return attrs;
}

/** Shared text presentation for SVG serialization and cached slide bindings.
 * Values are unescaped; a serializer escapes them and DOM setters do not.
 * `lines`/`x`/`advance` remain the flat view for callers that only need the
 * strings; `spans` carries the full arrangement (text.ts blockLayout). */
export function textSvgLayout(e: TextElement): {
  attrs: Record<string, string>;
  lines: string[];
  spans: TextSpan[];
  x: number;
  advance: number;
} {
  const L = blockLayout(e);
  const track = letterSpacing(e);
  return {
    attrs: {
      x: String(L.x), y: String(L.baselineY), "font-family": e.fontFamily,
      "font-size": String(e.fontSize), "font-weight": String(e.fontWeight),
      ...(e.fontStyle === "italic" ? { "font-style": "italic" } : {}),
      ...(e.underline ? { "text-decoration": "underline" } : {}),
      ...(track ? { "letter-spacing": String(track) } : {}),
      fill: passivePaint(e.color), "text-anchor": L.anchor,
      ...(e.opacity != null && e.opacity < 1 ? { opacity: String(e.opacity) } : {}),
    },
    lines: L.lines.map((ln) => ln.text),
    spans: L.lines.map((ln: LaidOutLine) => ({
      text: ln.text,
      x: L.x,
      dy: ln.dy,
      ...(ln.justifyWidth != null ? { textLength: ln.justifyWidth } : {}),
      ...(ln.segments ? { segments: ln.segments } : {}),
    })),
    x: L.x,
    advance: lineH(e),
  };
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
    `preserveAspectRatio="none" href="${esc(href)}"/></svg>`
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
    case "video":
      return elementToSvg({ ...e, type: "image", assetId: e.posterAssetId }, assetUrl, plotMarkup, assetSize);
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
          `preserveAspectRatio="none" href="${esc(href)}"${op(e)}/>`,
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
          `preserveAspectRatio="none" href="${esc(href)}"${op(e)}/>`,
      );
    }
    case "rect": {
      // P: solid colours, or url(#…) gradients + their <defs> when a colormap
      // is set (color/gradient.ts) — "" and the plain colour otherwise, so an
      // element without a map serializes byte-identically.
      const P = elementPaints(e);
      return rot(
        e,
        paintDefsSvg(P) +
          `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `rx="${e.cornerRadius}" fill="${esc(passivePaint(P.fill))}" stroke="${esc(passivePaint(P.stroke))}" ` +
          `stroke-width="${e.strokeWidth}"${dashA(e)}${op(e)}/>`,
      );
    }
    case "ellipse": {
      const P = elementPaints(e);
      return rot(
        e,
        paintDefsSvg(P) +
          `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" ` +
          `rx="${e.width / 2}" ry="${e.height / 2}" fill="${esc(passivePaint(P.fill))}" ` +
          `stroke="${esc(passivePaint(P.stroke))}" stroke-width="${e.strokeWidth}"${dashA(e)}${op(e)}/>`,
      );
    }
    case "line": {
      const lr = lineRender(e);
      const P = elementPaints(e);
      // op(e) on every piece: the canvas applies element opacity on the group
      // wrapper, so the export must too (a translucent line used to export
      // fully opaque).
      let s =
        paintDefsSvg(P) +
        `<line x1="${e.x + lr.x1}" y1="${e.y + lr.y1}" x2="${e.x + lr.x2}" y2="${e.y + lr.y2}" ` +
        `stroke="${esc(passivePaint(P.stroke))}" stroke-width="${e.strokeWidth}" ` +
        `stroke-linecap="${esc(lr.cap)}"${dashA(e)}${op(e)}/>`;
      for (const tri of lr.polys) {
        const pts = tri.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ");
        s += `<polygon points="${pts}" fill="${esc(passivePaint(P.heads))}"${op(e)}/>`;
      }
      for (const v of lr.vees) {
        const pts = v.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ");
        s +=
          `<polyline points="${pts}" fill="none" stroke="${esc(passivePaint(P.heads))}" ` +
          `stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${op(e)}/>`;
      }
      return rot(e, s);
    }
    case "path": {
      const pr = pathRender(e);
      const P = elementPaints(e);
      let s =
        paintDefsSvg(P) +
        `<path d="${esc(pr.d)}" fill="${esc(passivePaint(P.fill))}" ` +
        `stroke="${esc(passivePaint(P.stroke))}" stroke-width="${e.strokeWidth}" ` +
        `stroke-linejoin="round" stroke-linecap="${esc(e.cap ?? "round")}"${dashA(e)}${op(e)} ` +
        `transform="translate(${e.x} ${e.y})"/>`;
      for (const tri of pr.polys) {
        const pts = tri.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ");
        s += `<polygon points="${pts}" fill="${esc(passivePaint(P.heads))}"${op(e)}/>`;
      }
      for (const v of pr.vees) {
        const pts = v.map(([px, py]) => `${e.x + px},${e.y + py}`).join(" ");
        s +=
          `<polyline points="${pts}" fill="none" stroke="${esc(passivePaint(P.heads))}" ` +
          `stroke-width="${e.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${op(e)}/>`;
      }
      return rot(e, s);
    }
    case "text": {
      // textSvgLayout wraps text.ts blockLayout: the GUI's wrap cache when
      // present (sizing auto-h/fixed) else the hard lines, arranged by the
      // element's align/valign/line-height/paragraph-spacing. This ONE function
      // also serves flux-core's headless renderFigureSvg, so the arrangement is
      // identical everywhere.
      const { attrs, spans } = textSvgLayout(e);
      const P = elementPaints(e);
      if (P.defs.length) attrs.fill = P.fill;
      // A formatted line nests one tspan per differing piece. The nested tspans
      // carry NO x: that would restart the line at the anchor instead of
      // continuing it, and the justification stays on the line's own tspan.
      const content = (sp: (typeof spans)[number]) =>
        sp.segments
          ? sp.segments
              .map((seg) => {
                const segAttrs = Object.entries(segmentAttrs(e, seg));
                // `dx` is the justified word gap — an ordinary tspan offset, so
                // it survives every renderer that can place a tspan at all.
                if (seg.dx != null) segAttrs.unshift(["dx", String(seg.dx)]);
                return segAttrs.length
                  ? `<tspan ${segAttrs.map(([name, value]) => `${name}="${esc(value)}"`).join(" ")}>${esc(seg.text)}</tspan>`
                  : esc(seg.text);
              })
              .join("")
          : esc(sp.text);
      const tspans = spans
        .map(
          (sp) =>
            `<tspan x="${sp.x}" dy="${sp.dy}"` +
            (sp.textLength != null ? ` textLength="${sp.textLength}" lengthAdjust="spacing"` : "") +
            `>${content(sp)}</tspan>`,
        )
        .join("");
      return rot(
        e,
        paintDefsSvg(P) +
          `<text ${Object.entries(attrs).map(([name, value]) => `${name}="${esc(value)}"`).join(" ")}>${tspans}</text>`,
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
  opts?: {
    /** Render ONLY this named group's subtree, viewBox tight on its bbox —
     *  the slides "insert a figure group" substrate. Unknown/hidden group
     *  falls back to the full figure (a live embed must show SOMETHING when
     *  the group is later deleted in figure mode). */
    groupId?: string;
  },
): string {
  if (fig.background != null && typeof fig.background !== 'string') throw new Error(`Invalid figure background: ${fig.id}`);
  for (const key of ['x','y','width','height'] as const) if (!Number.isFinite(fig[key])) throw new Error(`Invalid figure ${key}: ${fig.id}`);

  const nodeToSvg = (n: RenderNode): string => {
    if (n.kind === "element") {
      // Layers eyes: an element hidden itself OR by any ancestor GROUP's eye
      // (P7 registry, groups.ts) is omitted from export. effectiveHidden (not
      // just the walk's group skip) also covers stragglers/dangling ids the
      // tree renders LOOSE outside their (hidden) group's wrapper.
      if (effectiveHidden(fig, n.el)) return "";
      const markup = elementToSvg(n.el, assetUrl, plotMarkup, assetSize);
      // Per-element wrapper id: makes every member individually addressable
      // from slides (Track part "el:<elementId>" — same grammar family as the
      // group wrappers). Plot PARTS inside keep their own <elId>__<partId> ids.
      return markup ? `<g id="${esc(fig.id)}__el:${esc(n.el.id)}">${markup}</g>` : "";
    }
    if (n.def.hidden) return ""; // hidden group: whole subtree omitted, no empty wrapper
    const inner = n.children.map(nodeToSvg).filter(Boolean).join("\n  ");
    if (!inner) return ""; // every member hidden → no wrapper either
    return (
      `<g data-flux-group="${esc(n.def.name)}" id="${esc(fig.id)}__group:${esc(n.def.id)}">\n  ` +
      `${inner}\n  </g>`
    );
  };
  const tree = buildRenderTree(fig);

  // Scoped render: just the group's wrapper subtree, no figure background,
  // viewBox tight on the visible members' bbox (padded for stroke overhang).
  if (opts?.groupId) {
    const find = (nodes: RenderNode[]): RenderNode | null => {
      for (const n of nodes) {
        if (n.kind === "group") {
          if (n.def.id === opts.groupId) return n;
          const hit = find(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const node = find(tree);
    const members = node ? membersDeep(fig, opts.groupId).filter((e) => !effectiveHidden(fig, e)) : [];
    const body = node ? nodeToSvg(node) : "";
    if (body && members.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad = 2;
      for (const e of members) {
        const b = elementBBox(e);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
        if ("strokeWidth" in e && typeof e.strokeWidth === "number") pad = Math.max(pad, e.strokeWidth);
      }
      const vx = x0 - pad, vy = y0 - pad, vw = x1 - x0 + 2 * pad, vh = y1 - y0 + 2 * pad;
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" ` +
        `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${vw}" height="${vh}" ` +
        `viewBox="${vx} ${vy} ${vw} ${vh}">\n  ${body}\n</svg>`
      );
    }
    // group gone / fully hidden → full-figure fallback below
  }

  const body = tree.map(nodeToSvg).filter(Boolean).join("\n  ");
  const bg =
    fig.background && fig.background !== "transparent"
      ? `<rect x="0" y="0" width="${fig.width}" height="${fig.height}" fill="${esc(passivePaint(fig.background))}"/>\n  `
      : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${fig.width}" height="${fig.height}" ` +
    `viewBox="0 0 ${fig.width} ${fig.height}">\n  ${bg}${body}\n</svg>`
  );
}
