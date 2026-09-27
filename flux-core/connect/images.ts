// Pack images: what the agent LOOKS at on connect. Core renders one overview
// per canvas; full adds every figure. Each image carries its proof code in the
// bottom-right corner, stamped into the SVG before rasterizing, so reporting
// the code proves the agent opened the picture. Written to the pack's images/.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { imageCode } from "./codes";
import type { BriefImage } from "./brief";
import type { InclusionPlan } from "./budget";
import type { ConnectFacts } from "./facts";
import { renderCanvasSvg, renderFigureSvg, rasterizeSvgToPng } from "../render";

export const CANVAS_MAX_EDGE = 2000;
export const FIGURE_MAX_EDGE = 1600;

/** Intrinsic size of an SVG document from its viewBox (else width/height attributes). */
export function svgSize(svg: string): { minX: number; minY: number; w: number; h: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const vb = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/.exec(tag);
  if (vb) return { minX: Number(vb[1]), minY: Number(vb[2]), w: Number(vb[3]), h: Number(vb[4]) };
  const num = (attr: string) => {
    const m = new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)`).exec(tag);
    return m ? Number(m[1]) : NaN;
  };
  const w = num("width"), h = num("height");
  return Number.isFinite(w) && Number.isFinite(h) ? { minX: 0, minY: 0, w, h } : null;
}

/** Add a small, legible code badge in the bottom-right corner of an SVG. */
export function stampSvg(svg: string, code: string, outputWidth: number): string {
  const size = svgSize(svg);
  const close = svg.lastIndexOf("</svg>");
  if (!size || close < 0) return svg;
  // Aim for ~11 output pixels of text regardless of the canvas's user units.
  const unitsPerPx = size.w / Math.max(1, outputWidth);
  const font = 11 * unitsPerPx;
  const padX = 5 * unitsPerPx, padY = 3 * unitsPerPx;
  const boxW = font * 0.62 * code.length + padX * 2;
  const boxH = font + padY * 2;
  const x = size.minX + size.w - boxW - 4 * unitsPerPx;
  const y = size.minY + size.h - boxH - 4 * unitsPerPx;
  const badge =
    `<g data-flux-proof="1"><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${2 * unitsPerPx}" fill="#fffcf0" fill-opacity="0.85" stroke="#6f6e69" stroke-opacity="0.5" stroke-width="${0.6 * unitsPerPx}"/>` +
    `<text x="${x + boxW / 2}" y="${y + padY + font * 0.82}" font-family="DejaVu Sans Mono, Menlo, Consolas, monospace" font-size="${font}" fill="#100f0f" fill-opacity="0.7" text-anchor="middle">${code}</text></g>`;
  return svg.slice(0, close) + badge + svg.slice(close);
}

function outWidth(svg: string, maxEdge: number): number {
  const s = svgSize(svg);
  if (!s) return maxEdge;
  // Render at up to 2 px per user unit, never beyond maxEdge on the long side.
  const scale = Math.min(2, maxEdge / Math.max(s.w, s.h));
  return Math.max(1, Math.round(s.w * scale));
}

export interface PackImagesResult {
  images: BriefImage[];
  /** Why rendering was skipped or partial (shown in the brief). */
  problems: string[];
}

/** Render the images a plan asks for into `<packDir>/images/`. Never throws; failures are reported. */
export async function renderPackImages(root: string, facts: ConnectFacts, plan: InclusionPlan, packDir: string): Promise<PackImagesResult> {
  const p = facts.project;
  const out: BriefImage[] = [];
  const problems: string[] = [];
  if (!p) return { images: out, problems };
  const dir = path.join(packDir, "images");
  await fs.mkdir(dir, { recursive: true });
  const names = new Map(p.figures.map((f) => [f.id, f.displayName]));
  let index = 0;
  const one = async (label: string, file: string, svg: () => Promise<string>, maxEdge: number) => {
    try {
      const raw = await svg();
      const width = outWidth(raw, maxEdge);
      const code = imageCode(facts.packId, index);
      const png = await rasterizeSvgToPng(stampSvg(raw, code, width), width);
      const abs = path.join(dir, file);
      await fs.writeFile(abs, png);
      out.push({ path: abs, label });
      index++;
    } catch (e) {
      problems.push(`${label}: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  for (const c of p.canvases) {
    if (!c.figureIds.length) continue;
    const members = c.figureIds.map((id) => `${id} "${names.get(id) ?? id}"`).join(", ");
    await one(`canvas "${c.name}": ${members}`, `canvas-${safe(c.id)}.png`, async () => (await renderCanvasSvg(root, c.id)).svg, CANVAS_MAX_EDGE);
  }
  if (plan.figureImages === "canvases+figures") {
    for (const f of p.figures) await one(`${f.id} "${f.displayName}"`, `figure-${safe(f.id)}.png`, () => renderFigureSvg(root, f.id), FIGURE_MAX_EDGE);
  }
  return { images: out, problems };
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}
