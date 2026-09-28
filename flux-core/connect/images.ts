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
import { createHash } from "node:crypto";
import { renderCanvasSvg, renderFigureSvg, rasterizeSvgToPng } from "../render";
import { modelPosterAvailabilitySignature } from "../model3dPosterCache";
import { buildInfo } from "../buildInfo";
import { ensureDom } from "../render";
import { gatherSlidePayload } from "../../src/lib/slide/payload";
import { renderSlidePosterSvg } from "../../src/lib/slide/embedRender";
import type { Deck } from "../../src/lib/slide/types";

/** Slides per contact sheet (4 columns); larger decks get several sheets. */
export const SHEET_SLIDES = 24;
const SHEET_COLS = 4;
const SHEET_CELL = 480;

export const CANVAS_MAX_EDGE = 2000;
export const FIGURE_MAX_EDGE = 1600;
/** Bump when the rendering of pack images changes in a way the key cannot see. */
export const RENDER_CACHE_VERSION = 1;
export const RENDER_CACHE_MAX_BYTES = 500 * 1024 * 1024;

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
  // Aim for ~11 output pixels of text regardless of the canvas's user units,
  // scaled up on large images: vision models downscale to ~1568 px on the long
  // edge, and the code must stay legible after that.
  const unitsPerPx = size.w / Math.max(1, outputWidth);
  const outputHeight = outputWidth * (size.h / Math.max(1e-9, size.w));
  const font = 11 * Math.max(1, Math.max(outputWidth, outputHeight) / 1400) * unitsPerPx;
  const padX = font * 0.45, padY = font * 0.27;
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

// ---------------------------------------------------------------------------
// The render cache: <cache base>/_render-cache/<key>.png, unstamped. The key is
// computed WITHOUT building the SVG (the expensive half): the figure index, the
// canvas file, the stats of every file under fig/assets, the build and a version.
// Each pack stamps its own code onto a copy (a cheap wrapper-SVG rasterization).
// ---------------------------------------------------------------------------

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

async function assetSignature(root: string): Promise<string> {
  const dir = path.join(root, "fig", "assets");
  const parts: string[] = [];
  const walk = async (rel: string) => {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else {
        const st = await fs.stat(path.join(dir, r)).catch(() => null);
        if (st) parts.push(`${r}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  };
  await walk("");
  return sha256(parts.join("\n"));
}

/** The cache key for one image, or null when the inputs cannot be read (render uncached). */
export async function renderKey(root: string, kind: "canvas" | "figure", id: string, canvasId: string, maxEdge: number, assets: string): Promise<string | null> {
  try {
    const index = await fs.readFile(path.join(root, "fig", "index.json"));
    const canvas = await fs.readFile(path.join(root, "fig", "canvases", `${canvasId}.json`));
    const b = buildInfo();
    return sha256([RENDER_CACHE_VERSION, b.version, b.commit, kind, id, maxEdge, sha256(index), sha256(canvas), assets].join("\0"));
  } catch {
    return null;
  }
}

/** Keep the cache under its cap, oldest-used first. Best effort. */
async function trimCache(dir: string, max = RENDER_CACHE_MAX_BYTES): Promise<void> {
  try {
    const files = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".png")) continue;
      const st = await fs.stat(path.join(dir, name)).catch(() => null);
      if (st) files.push({ name, size: st.size, t: st.mtimeMs });
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    for (const f of files.sort((a, b) => a.t - b.t)) {
      if (total <= max) break;
      await fs.rm(path.join(dir, f.name), { force: true });
      await fs.rm(path.join(dir, f.name.replace(/\.png$/, ".json")), { force: true });
      total -= f.size;
    }
  } catch {
    /* advisory */
  }
}

/** A cached (or fresh) unstamped raster → stamped PNG, via a one-image wrapper SVG. */
async function stampPng(png: Buffer, width: number, height: number, code: string): Promise<Buffer> {
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:image/png;base64,${png.toString("base64")}" x="0" y="0" width="${width}" height="${height}"/></svg>`;
  return rasterizeSvgToPng(stampSvg(wrapper, code, width), width);
}

export interface PackImagesResult {
  images: BriefImage[];
  /** Why rendering was skipped or partial (shown in the brief). */
  problems: string[];
  cache: { hits: number; misses: number };
}

/** Render the images a plan asks for into `<packDir>/images/`. Never throws; failures are reported. */
export async function renderPackImages(root: string, facts: ConnectFacts, plan: InclusionPlan, packDir: string): Promise<PackImagesResult> {
  const p = facts.project;
  const out: BriefImage[] = [];
  const problems: string[] = [];
  if (!p) return { images: out, problems, cache: { hits: 0, misses: 0 } };
  const dir = path.join(packDir, "images");
  await fs.mkdir(dir, { recursive: true });
  const cacheDir = path.join(path.dirname(path.dirname(packDir)), "_render-cache");
  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const assets = `${await assetSignature(root)}:${await modelPosterAvailabilitySignature(root)}`;
  let hits = 0, misses = 0;
  const names = new Map(p.figures.map((f) => [f.id, f.displayName]));
  // One line per distinct failure (a damaged figure model fails every render the same way).
  const failures = new Map<string, string[]>();
  let index = 0;
  const one = async (label: string, file: string, svg: (warnings: string[]) => Promise<string>, maxEdge: number, key: Promise<string | null>) => {
    try {
      const code = imageCode(facts.packId, index);
      const k = await key;
      let base: { png: Buffer; width: number; height: number } | null = null;
      const modelWarnings: string[] = [];
      if (k) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(cacheDir, `${k}.json`), "utf8")) as { width: number; height: number; warnings?: string[] };
          base = { png: await fs.readFile(path.join(cacheDir, `${k}.png`)), ...meta };
          modelWarnings.push(...meta.warnings ?? []);
          const now = new Date();
          await fs.utimes(path.join(cacheDir, `${k}.png`), now, now).catch(() => {});
          hits++;
        } catch {
          base = null;
        }
      }
      if (!base) {
        const raw = await svg(modelWarnings);
        const width = outWidth(raw, maxEdge);
        const size = svgSize(raw);
        const height = size ? Math.max(1, Math.round((width * size.h) / Math.max(1e-9, size.w))) : width;
        base = { png: await rasterizeSvgToPng(raw, width), width, height };
        misses++;
        if (k) {
          await fs.writeFile(path.join(cacheDir, `${k}.png`), base.png).catch(() => {});
          await fs.writeFile(path.join(cacheDir, `${k}.json`), JSON.stringify({ width: base.width, height: base.height, warnings: modelWarnings })).catch(() => {});
        }
      }
      problems.push(...modelWarnings);
      const png = await stampPng(base.png, base.width, base.height, code);
      const abs = path.join(dir, file);
      await fs.writeFile(abs, png);
      out.push({ path: abs, label });
      index++;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 240);
      failures.set(msg, [...(failures.get(msg) ?? []), label.split(":")[0]]);
    }
  };
  let n = 0;
  for (const c of p.canvases) {
    if (!c.figureIds.length) continue;
    const members = c.figureIds.map((id) => `${id} "${names.get(id) ?? id}"`).join(", ");
    await one(`canvas "${c.name}": ${members}`, `canvas-${++n}.png`, async warnings => (await renderCanvasSvg(root, c.id, { model3dPolicy: 'collect', warnings })).svg, CANVAS_MAX_EDGE, renderKey(root, "canvas", c.id, c.id, CANVAS_MAX_EDGE, assets));
  }
  if (plan.figureImages === "canvases+figures") {
    for (const f of p.figures.filter((x) => !x.empty))
      await one(`${f.id} "${f.displayName}"`, `figure-${safe(f.id)}.png`, warnings => renderFigureSvg(root, f.id, { model3dPolicy: 'collect', warnings }), FIGURE_MAX_EDGE, renderKey(root, "figure", f.id, f.canvasId, FIGURE_MAX_EDGE, assets));
  }
  if (plan.deckSheets) {
    for (const d of p.decks) {
      if (!d.slides.length || !d.path) continue;
      const deckFile = path.join(root, d.path);
      const deckText = await fs.readFile(deckFile, "utf8").catch(() => null);
      if (deckText === null) continue;
      const sheets = Math.ceil(d.slides.length / SHEET_SLIDES);
      for (let s = 0; s < sheets; s++) {
        const first = s * SHEET_SLIDES, last = Math.min(d.slides.length, first + SHEET_SLIDES);
        const label = `deck "${d.title}" (${d.id}): slides ${first + 1}–${last}${sheets > 1 ? ` of ${d.slides.length}` : ""}`;
        const b = buildInfo();
        const key = Promise.resolve(sha256([RENDER_CACHE_VERSION, b.version, b.commit, "deck", d.id, s, sha256(deckText), assets].join("\0")));
        await one(label, `deck-${safe(d.id)}-${s + 1}.png`, () => deckSheetSvg(root, JSON.parse(deckText) as Deck, first, last), CANVAS_MAX_EDGE, key);
      }
    }
  }
  if (misses) await trimCache(cacheDir);
  for (const [msg, labels] of failures)
    problems.push(`could not render ${labels.length === 1 ? labels[0] : `${labels.length} images (${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", …" : ""})`}: ${msg}`);
  return { images: out, problems: [...new Set(problems)], cache: { hits, misses } };
}

/**
 * A contact sheet: each slide's step-0 poster (the slide-embed renderer) is
 * rasterized on its own — inlining many posters in one SVG would collide
 * their ids — then laid out in a 4-column grid with "n. name" labels. Read-only:
 * the payload IO has no write methods.
 */
export async function deckSheetSvg(root: string, deck: Deck, first: number, last: number): Promise<string> {
  await ensureDom();
  const io = { readText: (p: string) => fs.readFile(p, "utf8"), readFile: (p: string) => fs.readFile(p) };
  const stage = deck.stage ?? { width: 1920, height: 1080 };
  const cellH = Math.round((SHEET_CELL * stage.height) / stage.width);
  const labelH = 34, gap = 16;
  const cols = Math.min(SHEET_COLS, last - first);
  const rows = Math.ceil((last - first) / cols);
  const W = gap + cols * (SHEET_CELL + gap), H = gap + rows * (cellH + labelH + gap);
  const parts: string[] = [];
  for (let i = first; i < last; i++) {
    const slide = deck.slides[i];
    const k = i - first, x = gap + (k % cols) * (SHEET_CELL + gap), y = gap + Math.floor(k / cols) * (cellH + labelH + gap);
    const name = (slide.name || `Slide ${i + 1}`).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
    let cell = `<rect x="${x}" y="${y}" width="${SHEET_CELL}" height="${cellH}" fill="#e6e4d9"/>`;
    try {
      const { payload } = await gatherSlidePayload(root, deck, slide.id, io);
      const png = await rasterizeSvgToPng(renderSlidePosterSvg(payload, 0), SHEET_CELL);
      cell = `<image href="data:image/png;base64,${png.toString("base64")}" x="${x}" y="${y}" width="${SHEET_CELL}" height="${cellH}"/>`;
    } catch {
      cell += `<text x="${x + SHEET_CELL / 2}" y="${y + cellH / 2}" font-family="DejaVu Sans, Arial, sans-serif" font-size="16" fill="#6f6e69" text-anchor="middle">(could not render)</text>`;
    }
    parts.push(cell, `<rect x="${x}" y="${y}" width="${SHEET_CELL}" height="${cellH}" fill="none" stroke="#b7b5ac" stroke-width="1"/>`,
      `<text x="${x}" y="${y + cellH + 23}" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" fill="#100f0f">${i + 1}. ${name}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fffcf0"/>${parts.join("")}</svg>`;
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_");
}
