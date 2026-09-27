// Slide deck -> PowerPoint .pptx (2026-09-24, owner request: "export slides
// in pptx too; vector images remain vector, so you can edit the single
// elements").
//
// Each slide is written at its final build step (the same evaluation as the
// PDF and document posters: embedRender.evaluateSlide) as NATIVE PowerPoint
// objects wherever Flux has an equivalent, so every element is selectable and
// editable in PowerPoint:
//   text     -> a text box, with per-range bold / italic / underline / colour /
//               superscript / subscript as runs, line and paragraph spacing,
//               tracking, alignment and vertical alignment;
//   rect     -> rectangle / rounded rectangle; ellipse -> ellipse;
//   line     -> a line with its arrowheads, cap and dash;
//   path     -> a freeform (custom geometry) you can "Edit Points" on;
// and as VECTOR pictures where it has none:
//   plot     -> the plot's SVG (asvg:svgBlip) with a PNG fallback for old
//               readers; PowerPoint's "Convert to Shape" breaks it into its
//               individual editable shapes and text;
//   gradient-painted shapes -> the same SVG picture treatment;
//   image / video -> the raster (a video's poster frame), crop kept.
// Animations are not translated: a slide shows where its builds end.
//
// Pure apart from the injected rasterizer (PNG fallbacks need a canvas): the
// renderer passes a canvas-backed one, the pure gate a stub.
import { zipSync, strToU8 } from "fflate";
import type { Element } from "../../types";
import type { ExportPayload } from "../payload";
import { evaluateSlide, type EvaluatedSlide } from "../embedRender";
import { effectiveHidden } from "../../groups";
import type { Figure as FigureShape } from "../../types";
import { elementToSvg } from "../../export";
import { elementOutline } from "../outline";
import { segsFromNodes } from "../../path";
import { segmentRange, type TextSegment } from "../../textRuns";
import { passivePaint } from "../../plot/passiveSvg";
import { dataUrlToBytes } from "../../assets";

/** Renders an SVG to PNG bytes at the given pixel size (the fallback image). */
export type Rasterize = (svg: string, widthPx: number, heightPx: number) => Promise<Uint8Array>;

export interface DeckPptxSlide { payload: ExportPayload; notes?: string }
export interface DeckPptxResult { bytes: Uint8Array; slides: number; warnings: string[] }

// ---- units -----------------------------------------------------------------
/** A standard 16:9 PowerPoint slide is 13.333 in wide; the stage maps onto it,
 *  so the file opens at the size PowerPoint users expect for any stage. */
const SLIDE_WIDTH_EMU = 12192000;
const EMU_PER_PX = 9525; // 96 px per inch

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  // XML 1.0 forbids most control characters; a stray one would corrupt the part.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const int = (v: number) => String(Math.round(v));

/** A colour as PowerPoint wants it: six hex digits plus an alpha, or null for
 *  "no paint". Named tokens resolve through passivePaint first. */
export function pptxColor(value: string | undefined | null): { rgb: string; alpha: number } | null {
  if (!value) return null;
  const v = passivePaint(value).trim().toLowerCase();
  if (v === "none" || v === "transparent") return null;
  let m = v.match(/^#([0-9a-f]{3,4})$/);
  if (m) {
    const [r, g, b, a] = m[1].split("").map((c) => parseInt(c + c, 16));
    return { rgb: [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase(), alpha: a === undefined ? 1 : a / 255 };
  }
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return { rgb: m[1].toUpperCase(), alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const hex = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0")).join("").toUpperCase();
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { rgb: hex, alpha: Math.max(0, Math.min(1, a)) };
  }
  return { rgb: "000000", alpha: 1 };
}
const srgb = (c: { rgb: string; alpha: number }, opacity = 1) => {
  const a = Math.round(c.alpha * opacity * 100000);
  return a < 100000 ? `<a:srgbClr val="${c.rgb}"><a:alpha val="${a}"/></a:srgbClr>` : `<a:srgbClr val="${c.rgb}"/>`;
};
const solid = (c: { rgb: string; alpha: number } | null, opacity = 1) => c ? `<a:solidFill>${srgb(c, opacity)}</a:solidFill>` : "<a:noFill/>";

// ---- the per-slide writer --------------------------------------------------
interface Media { name: string; bytes: Uint8Array; ext: "png" | "svg" | "jpeg" }
interface SlideContext {
  ev: EvaluatedSlide;
  payload: ExportPayload;
  emu: number; // EMU per stage px (camera zoom included)
  map: (x: number, y: number) => { x: number; y: number }; // stage px -> slide EMU
  zoom: number;
  nextId: () => number;
  media: Media[];
  rels: string[]; // relationship XML for this slide
  addMedia: (m: Omit<Media, "name">) => string; // returns the rId
  rasterize: Rasterize;
  warnings: string[];
}

function xfrm(ctx: SlideContext, x: number, y: number, w: number, h: number, rotation = 0, flipH = false, flipV = false): string {
  const o = ctx.map(x, y);
  const rot = rotation ? ` rot="${int(((rotation % 360) + 360) % 360 * 60000)}"` : "";
  return `<a:xfrm${rot}${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}><a:off x="${int(o.x)}" y="${int(o.y)}"/><a:ext cx="${int(Math.max(1, w * ctx.emu))}" cy="${int(Math.max(1, h * ctx.emu))}"/></a:xfrm>`;
}

function outlineXml(ctx: SlideContext, stroke: string | undefined, width: number, opacity: number, dash: number[] | undefined, extra = ""): string {
  const c = pptxColor(stroke);
  if (!c || !(width > 0)) return "<a:ln><a:noFill/></a:ln>";
  const w = width * ctx.emu;
  const dashXml = dash && dash.length >= 2 && width > 0
    ? `<a:custDash>${dash.reduce<string[]>((acc, v, i) => (i % 2 === 0 ? acc.push(`<a:ds d="${int((v / width) * 100000)}" sp="${int(((dash[i + 1] ?? v) / width) * 100000)}"/>`) : 0, acc), []).join("")}</a:custDash>`
    : "";
  return `<a:ln w="${int(w)}"${extra}>${solid(c, opacity)}${dashXml}</a:ln>`;
}

function nv(ctx: SlideContext, el: Element, kind: "sp" | "pic" | "cxnSp", txBox = false): string {
  const id = ctx.nextId(), name = esc(el.name || `${el.type} ${id}`);
  if (kind === "pic") return `<p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`;
  if (kind === "cxnSp") return `<p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`;
  return `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>`;
}

// ---- text ------------------------------------------------------------------
function runXml(ctx: SlideContext, el: Extract<Element, { type: "text" }>, seg: TextSegment, opacity: number): string {
  const pt = (px: number) => px * ctx.emu / EMU_PER_PX * 0.75;
  const bold = seg.bold ?? el.fontWeight >= 600, italic = seg.italic ?? el.fontStyle === "italic", underline = seg.underline ?? !!el.underline;
  const color = pptxColor(seg.color ?? el.color) ?? { rgb: "000000", alpha: 1 };
  const spc = el.letterSpacing ? ` spc="${int(pt(el.letterSpacing) * 100)}"` : "";
  // PowerPoint sets super/subscript smaller by itself; the offset is a percentage.
  const baseline = seg.script === "super" ? ' baseline="30000"' : seg.script === "sub" ? ' baseline="-25000"' : "";
  const face = esc(el.fontFamily);
  return `<a:r><a:rPr lang="en-US" sz="${int(pt(el.fontSize) * 100)}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}"${underline ? ' u="sng"' : ""}${baseline}${spc} dirty="0">` +
    `${solid(color, opacity)}<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/></a:rPr><a:t>${esc(seg.text)}</a:t></a:r>`;
}

function textXml(ctx: SlideContext, el: Extract<Element, { type: "text" }>): string {
  const opacity = el.opacity ?? 1;
  const pt = (px: number) => px * ctx.emu / EMU_PER_PX * 0.75;
  const lineH = el.fontSize * (el.lineHeight ?? 1.2);
  const algn = el.align === "center" ? "ctr" : el.align === "right" ? "r" : el.align === "justify" ? "just" : "l";
  const anchor = el.valign === "middle" ? "ctr" : el.valign === "bottom" ? "b" : "t";
  const gap = Number.isFinite(el.paragraphSpacing) ? (el.paragraphSpacing as number) : 0;
  const paragraphs: string[] = [];
  let at = 0;
  for (const [k, line] of el.text.split("\n").entries()) {
    const from = at, to = at + line.length;
    at = to + 1;
    const pPr = `<a:pPr algn="${algn}"><a:lnSpc><a:spcPts val="${int(pt(lineH) * 100)}"/></a:lnSpc>${k > 0 && gap ? `<a:spcBef><a:spcPts val="${int(pt(gap) * 100)}"/></a:spcBef>` : ""}</a:pPr>`;
    const runs = segmentRange(el.text, el.runs, from, to).map((seg) => runXml(ctx, el, seg, opacity)).join("");
    const end = `<a:endParaRPr lang="en-US" sz="${int(pt(el.fontSize) * 100)}" dirty="0"/>`;
    paragraphs.push(`<a:p>${pPr}${runs}${end}</a:p>`);
  }
  // A hugging box must not re-wrap in PowerPoint's metrics; a wrapping one
  // keeps its width, so PowerPoint wraps where its fonts say.
  const wrap = el.sizing === "auto" || !el.sizing ? "none" : "square";
  const w = el.sizing === "auto" || !el.sizing ? el.width * 1.04 : el.width;
  const body = `<p:txBody><a:bodyPr wrap="${wrap}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs.join("")}</p:txBody>`;
  return `<p:sp>${nv(ctx, el, "sp", true)}<p:spPr>${xfrm(ctx, el.x, el.y, w, Math.max(el.height, el.fontSize), el.rotation, el.flipX, el.flipY)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${body}</p:sp>`;
}

// ---- shapes ----------------------------------------------------------------
function rectXml(ctx: SlideContext, el: Extract<Element, { type: "rect" | "ellipse" }>): string {
  const opacity = el.opacity ?? 1;
  let geom = '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  if (el.type === "rect") {
    const r = el.cornerRadius ?? 0, short = Math.max(1e-6, Math.min(el.width, el.height));
    geom = r > 0
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${int(Math.min(50000, (r / short) * 100000))}"/></a:avLst></a:prstGeom>`
      : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  }
  return `<p:sp>${nv(ctx, el, "sp")}<p:spPr>${xfrm(ctx, el.x, el.y, el.width, el.height, el.rotation, el.flipX, el.flipY)}${geom}${solid(pptxColor(el.fill), opacity)}${outlineXml(ctx, el.stroke, el.strokeWidth, opacity, el.dash)}</p:spPr></p:sp>`;
}

function arrowEnds(el: { arrowStart?: boolean; arrowEnd?: boolean; arrowStyle?: "filled" | "vee" }): string {
  const type = el.arrowStyle === "vee" ? "arrow" : "triangle";
  return `${el.arrowStart ? `<a:headEnd type="${type}" w="med" len="med"/>` : ""}${el.arrowEnd ? `<a:tailEnd type="${type}" w="med" len="med"/>` : ""}`;
}

function lineXml(ctx: SlideContext, el: Extract<Element, { type: "line" }>): string {
  // Endpoints are element-local around a box that may be rotated about its
  // centre: resolve them to stage coordinates, then draw an unrotated line.
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2, t = (el.rotation * Math.PI) / 180;
  const at = (lx: number, ly: number) => {
    const dx = el.x + lx - cx, dy = el.y + ly - cy;
    return { x: cx + dx * Math.cos(t) - dy * Math.sin(t), y: cy + dx * Math.sin(t) + dy * Math.cos(t) };
  };
  const a = at(el.x1, el.y1), b = at(el.x2, el.y2);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const cap = el.cap === "butt" ? "flat" : el.cap === "square" ? "sq" : "rnd";
  const opacity = el.opacity ?? 1;
  const ln = outlineXml(ctx, el.stroke, el.strokeWidth, opacity, el.dash, ` cap="${cap}"`).replace("</a:ln>", `${arrowEnds(el)}</a:ln>`);
  return `<p:cxnSp>${nv(ctx, el, "cxnSp")}<p:spPr>${xfrm(ctx, x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y), 0, b.x < a.x, b.y < a.y)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:cxnSp>`;
}

function pathXml(ctx: SlideContext, el: Extract<Element, { type: "path" }>): string | null {
  const outline = elementOutline(el); // corner fillets and flips already applied
  if (!outline) return null;
  const segs = segsFromNodes(outline.nodes, outline.closed);
  if (!segs.length) return null;
  const k = ctx.emu, W = Math.max(1, el.width * k), H = Math.max(1, el.height * k);
  const p = (x: number, y: number) => `<a:pt x="${int(x * k)}" y="${int(y * k)}"/>`;
  let d = `<a:moveTo>${p(segs[0].x0, segs[0].y0)}</a:moveTo>`;
  for (const s of segs) d += s.line ? `<a:lnTo>${p(s.x3, s.y3)}</a:lnTo>` : `<a:cubicBezTo>${p(s.x1, s.y1)}${p(s.x2, s.y2)}${p(s.x3, s.y3)}</a:cubicBezTo>`;
  if (outline.closed) d += "<a:close/>";
  const opacity = el.opacity ?? 1;
  const fill = outline.closed ? solid(pptxColor(el.fill), opacity) : "<a:noFill/>";
  const ln = outlineXml(ctx, el.stroke, el.strokeWidth, opacity, el.dash).replace("</a:ln>", `${arrowEnds(el as never)}</a:ln>`);
  const geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${int(W)}" h="${int(H)}"${outline.closed ? "" : ' fill="none"'}>${d}</a:path></a:pathLst></a:custGeom>`;
  return `<p:sp>${nv(ctx, el, "sp")}<p:spPr>${xfrm(ctx, el.x, el.y, el.width, el.height, el.rotation)}${geom}${fill}${ln}</p:spPr></p:sp>`;
}

// ---- pictures --------------------------------------------------------------
function picXml(ctx: SlideContext, el: Element, x: number, y: number, w: number, h: number, rotation: number, blip: string, srcRect = ""): string {
  const opacity = el.opacity ?? 1;
  const alpha = opacity < 1 ? `<a:alphaModFix amt="${int(opacity * 100000)}"/>` : "";
  const withAlpha = alpha ? blip.replace(/^<a:blip ([^>]*?)(\/?)>/, (_m, attrs, selfClose) => selfClose ? `<a:blip ${attrs}>${alpha}</a:blip>` : `<a:blip ${attrs}>${alpha}`) : blip;
  return `<p:pic>${nv(ctx, el, "pic")}<p:blipFill>${withAlpha}${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(ctx, x, y, w, h, rotation)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

/** A vector picture: the SVG itself, with a PNG fallback PowerPoint needs for
 *  readers without SVG support. */
async function svgPicture(ctx: SlideContext, el: Element, svg: string, x: number, y: number, w: number, h: number, rotation: number): Promise<string> {
  const scale = 2; // fallback raster at 2x the stage size
  const png = await ctx.rasterize(svg, Math.max(1, Math.round(w * ctx.zoom * scale)), Math.max(1, Math.round(h * ctx.zoom * scale)));
  const pngId = ctx.addMedia({ bytes: png, ext: "png" });
  const svgId = ctx.addMedia({ bytes: strToU8(svg), ext: "svg" });
  const blip = `<a:blip r:embed="${pngId}"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgId}"/></a:ext></a:extLst></a:blip>`;
  return picXml(ctx, el, x, y, w, h, rotation, blip);
}

const standaloneSvg = (inner: string, w: number, h: number, ox = 0, oy = 0) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `${ox || oy ? `<g transform="translate(${-ox} ${-oy})">${inner}</g>` : inner}</svg>`;

async function plotXml(ctx: SlideContext, el: Extract<Element, { type: "plot" }>): Promise<string> {
  // Drawn unrotated at the origin; the picture frame carries the rotation, so
  // "Convert to Shape" yields axis-aligned pieces inside a rotated group.
  const flat = { ...el, x: 0, y: 0, rotation: 0 };
  const markup = ctx.ev.plotMarkup(flat);
  if (!markup) throw new Error(`Cannot render plot ${el.name ?? el.id}`);
  return svgPicture(ctx, el, standaloneSvg(markup, el.width, el.height), el.x, el.y, el.width, el.height, el.rotation);
}

async function vectorFallbackXml(ctx: SlideContext, el: Element): Promise<string> {
  // No native equivalent (a colormap gradient): the element as its own SVG,
  // padded so a stroke on the box edge is not cut, rotation baked in.
  const pad = ("strokeWidth" in el ? (el as { strokeWidth: number }).strokeWidth : 0) + 2;
  const r = (el.rotation * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const bw = el.width * c + el.height * s, bh = el.width * s + el.height * c;
  const bx = el.x + el.width / 2 - bw / 2 - pad, by = el.y + el.height / 2 - bh / 2 - pad;
  const inner = elementToSvg(el, (id) => ctx.payload.assets?.[id], ctx.ev.plotMarkup, (id) => ctx.payload.assetSizes?.[id]);
  return svgPicture(ctx, el, standaloneSvg(inner, bw + 2 * pad, bh + 2 * pad, bx, by), bx, by, bw + 2 * pad, bh + 2 * pad, 0);
}

function rasterXml(ctx: SlideContext, el: Element, assetId: string, crop: { x: number; y: number; width: number; height: number } | null | undefined): string | null {
  const url = ctx.payload.assets?.[assetId];
  if (!url || !url.startsWith("data:image/")) return null;
  const mime = url.slice(5, url.indexOf(";"));
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" || mime === "image/jpg" ? "jpeg" : null;
  if (!ext) return null;
  const id = ctx.addMedia({ bytes: dataUrlToBytes(url), ext });
  let srcRect = "";
  const size = ctx.payload.assetSizes?.[assetId];
  if (crop && size && size.width > 0 && size.height > 0) {
    const pc = (v: number, of: number) => int((v / of) * 100000);
    srcRect = `<a:srcRect l="${pc(crop.x, size.width)}" t="${pc(crop.y, size.height)}" r="${pc(size.width - crop.x - crop.width, size.width)}" b="${pc(size.height - crop.y - crop.height, size.height)}"/>`;
  }
  return picXml(ctx, el, el.x, el.y, el.width, el.height, el.rotation, `<a:blip r:embed="${id}"/>`, srcRect);
}

async function elementXml(ctx: SlideContext, el: Element): Promise<string | null> {
  if (el.hidden) return null;
  const painted = "fillMap" in el && (el as { fillMap?: unknown }).fillMap || "strokeMap" in el && (el as { strokeMap?: unknown }).strokeMap;
  switch (el.type) {
    case "text": return painted ? vectorFallbackXml(ctx, el) : textXml(ctx, el);
    case "rect":
    case "ellipse": return painted ? vectorFallbackXml(ctx, el) : rectXml(ctx, el);
    case "line": return painted ? vectorFallbackXml(ctx, el) : lineXml(ctx, el);
    case "path": return painted ? vectorFallbackXml(ctx, el) : (pathXml(ctx, el) ?? vectorFallbackXml(ctx, el));
    case "plot": return plotXml(ctx, el);
    case "image": return rasterXml(ctx, el, el.assetId, el.crop) ?? vectorFallbackXml(ctx, el);
    case "video": return rasterXml(ctx, el, el.posterAssetId, null);
    default: return vectorFallbackXml(ctx, el);
  }
}

// ---- package parts ---------------------------------------------------------
const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: [string, string, string][]) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${target}"/>`).join("")}</Relationships>`;
const EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function themeXml(): string {
  const sys = (name: string, rgb: string) => `<a:${name}><a:srgbClr val="${rgb}"/></a:${name}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Flux"><a:themeElements>` + // flux-cap-ok: display name in the PowerPoint package, not a path
    `<a:clrScheme name="Flux">${sys("dk1", "000000")}${sys("lt1", "FFFFFF")}${sys("dk2", "1F2937")}${sys("lt2", "F2F0E5")}${sys("accent1", "205EA6")}${sys("accent2", "AF3029")}${sys("accent3", "66800B")}${sys("accent4", "AD8301")}${sys("accent5", "5E409D")}${sys("accent6", "24837B")}${sys("hlink", "205EA6")}${sys("folHlink", "5E409D")}</a:clrScheme>` + // flux-cap-ok: display name in the PowerPoint package, not a path
    '<a:fontScheme name="Flux"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' + // flux-cap-ok: display name in the PowerPoint package, not a path
    `<a:fmtScheme name="Flux"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>` + // flux-cap-ok: display name in the PowerPoint package, not a path
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/** Write a PowerPoint package from each slide's payload (gatherSlidePayload). */
export async function deckPptxBytes(title: string, slides: DeckPptxSlide[], rasterize: Rasterize): Promise<DeckPptxResult> {
  if (!slides.length) throw new Error("This deck has no slides to export");
  const stage = slides[0].payload.deck.stage;
  const emuBase = SLIDE_WIDTH_EMU / stage.width;
  const slideW = SLIDE_WIDTH_EMU, slideH = Math.round(stage.height * emuBase);
  const files: Record<string, Uint8Array> = {};
  const warnings: string[] = [];
  let mediaCount = 0;
  const contentDefaults = new Set<string>();

  for (const [i, s] of slides.entries()) {
    const n = i + 1;
    const ev = evaluateSlide(s.payload, Math.max(0, s.payload.deck.slides[0].beats.length - 1));
    const cam = ev.camera, zoom = cam?.zoom ?? 1;
    const relItems: [string, string, string][] = [["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]];
    let shapeId = 1;
    const ctx: SlideContext = {
      ev, payload: s.payload, emu: emuBase * zoom, zoom, warnings, rasterize, media: [], rels: [],
      map: (x, y) => cam
        ? { x: ((x - cam.x) * zoom + stage.width / 2) * emuBase, y: ((y - cam.y) * zoom + stage.height / 2) * emuBase }
        : { x: x * emuBase, y: y * emuBase },
      nextId: () => ++shapeId,
      addMedia: (m) => {
        const name = `image${++mediaCount}.${m.ext}`;
        files[`ppt/media/${name}`] = m.bytes;
        contentDefaults.add(m.ext);
        const id = `rId${relItems.length + 1}`;
        relItems.push([id, "image", `../media/${name}`]);
        return id;
      },
    };
    const shapes: string[] = [];
    // Layers eyes: an element hidden itself OR by any ancestor group's eye is
    // out, exactly as figureToSvg (export.ts) decides for the poster, PDF and
    // HTML paths. Array order is draw order here too: a group's members occupy
    // one contiguous run of the elements array (groups.ts invariant).
    const eyes = { elements: ev.elements, groups: ev.groups } as unknown as FigureShape;
    for (const el of ev.elements) {
      if (effectiveHidden(eyes, el)) continue;
      try {
        const xml = await elementXml(ctx, el);
        if (xml) shapes.push(xml);
      } catch (error) {
        warnings.push(`Slide ${n}: ${el.name ?? el.id} was left out (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    const bg = pptxColor(ev.background);
    const bgXml = bg ? `<p:bg><p:bgPr>${solid(bg)}<a:effectLst/></p:bgPr></p:bg>` : "";
    files[`ppt/slides/slide${n}.xml`] = strToU8(`${XML}<p:sld ${NS_P}><p:cSld name="${esc(ev.slide.name ?? `Slide ${n}`)}">${bgXml}<p:spTree>${EMPTY_TREE}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(rels(relItems));
  }

  const count = slides.length;
  const slideRels: [string, string, string][] = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
    ...slides.map((_, i) => [`rId${i + 2}`, "slide", `slides/slide${i + 1}.xml`] as [string, string, string]),
    [`rId${count + 2}`, "presProps", "presProps.xml"], [`rId${count + 3}`, "viewProps", "viewProps.xml"],
    [`rId${count + 4}`, "theme", "theme/theme1.xml"], [`rId${count + 5}`, "tableStyles", "tableStyles.xml"]];
  files["ppt/presentation.xml"] = strToU8(`${XML}<p:presentation ${NS_P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${slideW}" cy="${slideH}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`);
  files["ppt/_rels/presentation.xml.rels"] = strToU8(rels(slideRels));
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(`${XML}<p:sldMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]));
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(`${XML}<p:sldLayout ${NS_P} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = strToU8(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
  files["ppt/theme/theme1.xml"] = strToU8(themeXml());
  files["ppt/presProps.xml"] = strToU8(`${XML}<p:presentationPr ${NS_P}/>`);
  files["ppt/viewProps.xml"] = strToU8(`${XML}<p:viewPr ${NS_P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  files["ppt/tableStyles.xml"] = strToU8(`${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  files["docProps/core.xml"] = strToU8(`${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Flux</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`); // flux-cap-ok: display name in the PowerPoint package, not a path
  files["docProps/app.xml"] = strToU8(`${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Flux</Application><Slides>${count}</Slides></Properties>`); // flux-cap-ok: display name in the PowerPoint package, not a path
  files["_rels/.rels"] = strToU8(rels([["rId1", "officeDocument", "ppt/presentation.xml"],
    ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
    ["rId3", "extended-properties", "docProps/app.xml"]]));
  const mime: Record<string, string> = { png: "image/png", svg: "image/svg+xml", jpeg: "image/jpeg" };
  const PML = "application/vnd.openxmlformats-officedocument.presentationml";
  files["[Content_Types].xml"] = strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    [...contentDefaults].map((e) => `<Default Extension="${e}" ContentType="${mime[e]}"/>`).join("") +
    `<Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/>` +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${PML}.slide+xml"/>`).join("") +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/>` +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    `<Override PartName="/ppt/presProps.xml" ContentType="${PML}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${PML}.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="${PML}.tableStyles+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  // [Content_Types].xml first, as Office writes it; media already compressed.
  const ordered: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { "[Content_Types].xml": files["[Content_Types].xml"] };
  for (const [name, data] of Object.entries(files)) if (name !== "[Content_Types].xml") ordered[name] = /\.(png|jpeg)$/.test(name) ? [data, { level: 0 }] : data;
  return { bytes: zipSync(ordered, { level: 6 }), slides: count, warnings };
}

/** The renderer's rasterizer: the SVG through an <img> onto a canvas. Capped
 *  at 4096 px per side, which is plenty for a fallback image. */
export const canvasRasterize: Rasterize = async (svg, widthPx, heightPx) => {
  const scale = Math.min(1, 4096 / Math.max(widthPx, heightPx));
  const w = Math.max(1, Math.round(widthPx * scale)), h = Math.max(1, Math.round(heightPx * scale));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Read a SAVED deck and write it as .pptx bytes. Static pages show a video's
 *  poster frame, so the movie itself is never read. */
export async function deckPptxDocument(root: string, deckId: string, io: import("../payload").SlidePayloadIO, rasterize: Rasterize): Promise<DeckPptxResult> {
  const { readEmbedDeck, gatherSlidePayload } = await import("../payload");
  const staticIO = { ...io, videoUrl: async () => "" };
  const deck = await readEmbedDeck(root, deckId, staticIO);
  const slides: DeckPptxSlide[] = [];
  const warnings: string[] = [];
  for (const slide of deck.slides) {
    const result = await gatherSlidePayload(root, deck, slide.id, staticIO);
    for (const w of result.warnings) if (!warnings.includes(w)) warnings.push(w);
    slides.push({ payload: result.payload });
  }
  const out = await deckPptxBytes(deck.title, slides, rasterize);
  return { ...out, warnings: [...warnings, ...out.warnings] };
}
