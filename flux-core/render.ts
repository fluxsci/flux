// flux-core/render.ts — headless figure/canvas rendering (split out of
// index.ts; WS-6.2): standalone SVG via the GUI's figureToSvg (semantic-plot
// overrides baked in), PNG via resvg in a child process, whole-canvas looks,
// and the fig/renders/ materialization Quarto reads from disk.

import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { figureToSvg } from "../src/lib/export";
import { preparePlot, prefixIds, applyOverrides } from "../src/lib/plot/parse";
import { compensatePtTrue, svgIntrinsicPx, cropViewBoxValue } from "../src/lib/plot/compensate";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Element, Figure, Project } from "../src/lib/types";
import { migrateProject } from "../src/lib/migrate";
import * as ops from "../src/lib/ops";
import { atomicWrite } from "./fsx";
import { j } from "./journal";
import { requireProject, safeJoin, exists, readFigIndex, readCanvasFiles } from "./model";
import { scanAbsurdPathCoords } from "./coordscan";

function mimeFor(kind: string): string {
  return kind === "svg" ? "image/svg+xml" : "image/png";
}

// Headless DOM (linkedom) so we can reuse the GUI's pure plot functions
// (preparePlot/prefixIds/applyOverrides/compensatePtTrue) — exactly like the
// in-app plotToSvgMarkup, one source of truth. Exported for slides.ts
// (gatherDeckPayload derives manifests for vanilla plots through the same seam).
let domReady = false;
export async function ensureDom(): Promise<void> {
  if (domReady) return;
  const { DOMParser } = await import("linkedom");
  const g = globalThis as unknown as { DOMParser?: unknown };
  if (!g.DOMParser) g.DOMParser = DOMParser;
  domReady = true;
}

/** Inline a placed semantic plot to an <svg> string with its overrides baked in
 *  (mirrors src/lib/plot/export.ts plotToSvgMarkup, but reads from disk).
 *  Runs the SAME preparePlot seam as the app's cachePlot — normalization
 *  (sanitize / shared-<use> inlining / id stamping) + orphan augmentation —
 *  so group-keyed overrides (`unclassified`, derived groups) resolve
 *  identically headless, and the same crop + pt-true compensation. */
function buildPlotMarkup(
  svgText: string,
  el: Element & {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    crop?: { x: number; y: number; width: number; height: number };
    contentScale?: number;
  },
  overrides: Record<string, unknown> | undefined,
  manifest: FluxPlotManifest | undefined,
): string | null {
  const prepared = preparePlot(svgText, manifest);
  const rootEl = prepared.root;
  if (!rootEl) return null;
  const intrinsic = svgIntrinsicPx(rootEl as unknown as globalThis.Element);
  prefixIds(rootEl as unknown as globalThis.Element, el.id);
  rootEl.setAttribute("x", String(el.x));
  rootEl.setAttribute("y", String(el.y));
  rootEl.setAttribute("width", String(el.width));
  rootEl.setAttribute("height", String(el.height));
  rootEl.setAttribute("preserveAspectRatio", "none");
  if (el.crop) {
    // NOTE: preparePlot never mutates width/height/viewBox, so reading the
    // original viewBox off the prepared root pre-override is still valid here.
    rootEl.setAttribute(
      "viewBox",
      cropViewBoxValue(rootEl.getAttribute("viewBox"), intrinsic, el.crop),
    );
    rootEl.setAttribute("overflow", "hidden");
  }
  applyOverrides(
    rootEl as unknown as globalThis.Element,
    overrides as Parameters<typeof applyOverrides>[1],
    el.id,
    prepared.manifest,
  );
  compensatePtTrue(rootEl as unknown as globalThis.Element, {
    elW: el.width,
    elH: el.height,
    crop: el.crop ?? null,
    contentScale: el.contentScale,
    intrinsic,
  });
  return (rootEl as unknown as { toString(): string }).toString();
}

/** render-figure → a standalone SVG string (reuses the GUI's figureToSvg). For
 *  semantic plots the per-part overrides are baked in (faithful to the GUI);
 *  image/svg assets are inlined as data URLs. */
/** Member metadata for one figure (elementId → {type, name?, plot assetId}) —
 *  the slides export payload carries it so "el:<mid>/<partId>" tracks resolve
 *  offline through the member plot's manifest. */
export async function figureMembersOf(
  root: string,
  id: string,
): Promise<Record<string, { type: string; name?: string; assetId?: string }>> {
  const index = await readFigIndex(root);
  if (!index) return {};
  const { byId } = await readCanvasFiles(root, index);
  const fig = byId[id];
  if (!fig) return {};
  // Same migration every loader runs (legacy type:"svg" → plot, …).
  migrateProject({ version: 2, name: "", canvases: [], figures: [fig], assets: [], palette: [] });
  const out: Record<string, { type: string; name?: string; assetId?: string }> = {};
  for (const e of fig.elements) {
    const info: { type: string; name?: string; assetId?: string } = { type: e.type };
    if (e.name) info.name = e.name;
    if (e.type === "plot") info.assetId = (e as { assetId: string }).assetId;
    out[e.id] = info;
  }
  return out;
}

/** WS-12: warnings for text elements a headless edit left UNWRAPPED
 *  (needsLayout). Renders/exports proceed — a cosmetic wrap must not break an
 *  agent pipeline — but the GUI-parity gap is named instead of silent. */
export function textLayoutWarnings(figures: Figure[]): string[] {
  const out: string[] = [];
  for (const f of figures)
    for (const e of f.elements) {
      if (e.type !== "text" || !e.needsLayout) continue;
      out.push(
        `figure "${f.id}": text ${e.id}${e.name ? ` ("${e.name}")` : ""} was edited headless and renders with UNWRAPPED lines (sizing "${e.sizing}") — open the project in Flux once to re-wrap`,
      );
    }
  return out;
}

/** Load-and-scan convenience for the CLI/MCP render surfaces. */
export async function textLayoutProbe(
  root: string,
  opts: { figureId?: string; canvasId?: string; figureIds?: string[] } = {},
): Promise<string[]> {
  const index = await readFigIndex(root).catch(() => null);
  if (!index) return [];
  const { byId } = await readCanvasFiles(root, index);
  let figs = Object.values(byId);
  if (opts.figureId) figs = figs.filter((f) => f.id === opts.figureId);
  else if (opts.figureIds) {
    const want = new Set(opts.figureIds);
    figs = figs.filter((f) => want.has(f.id));
  } else if (opts.canvasId) figs = figs.filter((f) => f.canvasId === opts.canvasId);
  return textLayoutWarnings(figs);
}

export async function renderFigureSvg(
  root: string,
  id: string,
  opts?: { groupId?: string; onlyElement?: string },
): Promise<string> {
  await requireProject(root);
  const index = await readFigIndex(root);
  if (!index) throw new Error("no fig/index.json (run `flux reindex` or open the project once)");
  const { byId } = await readCanvasFiles(root, index);
  let fig = byId[id];
  if (!fig) throw new Error(`figure not found: ${id}`);
  if (opts?.onlyElement) {
    // Panel-bisect support: render with every OTHER plot hidden, keeping the
    // composed nested-<svg> context that standalone panel renders don't have.
    fig = {
      ...fig,
      elements: fig.elements.map((e) =>
        e.type === "plot" && e.id !== opts.onlyElement ? { ...e, hidden: true } : e,
      ),
    };
  }
  // Same migration every loader runs (legacy type:"svg" → semantic plot, …):
  // this reads canvas files directly, so unmigrated on-disk docs must still
  // render through the current element union. The pseudo-project also feeds
  // ops.assetDisplaySize below (crop rendering for <image>-backed elements),
  // so its assets keep the pHYs dpi.
  const renderProject: Project = {
    version: 2,
    name: "",
    canvases: [],
    figures: [fig],
    assets: (index.assets ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      kind: a.kind,
      path: a.path ?? "",
      naturalWidth: a.naturalWidth ?? 0,
      naturalHeight: a.naturalHeight ?? 0,
      ...(a.dpi != null ? { dpi: a.dpi } : {}),
    })),
    palette: [],
  };
  migrateProject(renderProject);

  const assetCache: Record<string, string> = {};
  const assetPath: Record<string, string> = {};
  for (const a of index.assets ?? []) {
    if (!a.path) continue;
    assetPath[a.id] = a.path;
    const ap = j(root, "fig", a.path);
    if (await exists(ap)) {
      const bytes = await fs.readFile(ap);
      assetCache[a.id] = `data:${mimeFor(a.kind)};base64,${bytes.toString("base64")}`;
    }
  }

  // Build faithful inline markup for each semantic plot element.
  const plotMarkup = new Map<string, string>();
  const plots = fig.elements.filter((e) => e.type === "plot");
  if (plots.length) {
    await ensureDom();
    for (const el of plots) {
      const rel = assetPath[(el as { assetId: string }).assetId];
      if (!rel) continue;
      const svgText = await fs.readFile(j(root, "fig", rel), "utf8").catch(() => null);
      if (!svgText) continue;
      let manifest: FluxPlotManifest | undefined;
      // Prefer the asset-local sidecar (always in-root, written on import/save) —
      // then fall back to the original source manifest for older projects. AGT-11:
      // source.manifestPath can point outside root (plot imported from elsewhere),
      // where safeJoin throws; the asset-local copy avoids that entirely.
      const aid = (el as { assetId?: string }).assetId;
      if (aid) {
        try {
          manifest = JSON.parse(await fs.readFile(j(root, "fig", "assets", `${aid}.fluxplot.json`), "utf8")) as FluxPlotManifest;
        } catch {
          /* no asset-local sidecar — try the source manifest below */
        }
      }
      const src = (el as { source?: { manifestPath?: string } }).source;
      if (!manifest && src?.manifestPath) {
        try {
          manifest = JSON.parse(await fs.readFile(safeJoin(root, src.manifestPath), "utf8")) as FluxPlotManifest;
        } catch {
          /* manifest optional (leaf-id overrides still apply) */
        }
      }
      const markup = buildPlotMarkup(
        svgText,
        el as Element & { id: string; x: number; y: number; width: number; height: number },
        (el as { overrides?: Record<string, unknown> }).overrides,
        manifest,
      );
      if (markup) plotMarkup.set(el.id, markup);
    }
  }

  return figureToSvg(
    fig,
    (aid) => assetCache[aid],
    (e) => plotMarkup.get(e.id),
    // Crop rendering for <image>-backed elements: same intrinsic-size source
    // as the GUI (assetDisplaySize over the index's asset dims + dpi).
    (aid) => ops.assetDisplaySize(renderProject, aid) ?? undefined,
    opts,
  );
}

// --- Rasterization (resvg) runs OUT OF PROCESS. A pathological SVG can PANIC
// resvg's Rust runtime; in-process that abort can take the thread pool down and
// let node exit 0 with no PNG and no error — the worst failure mode for a
// workflow built around "look at what you make". A child process turns any
// crash into a real non-zero exit + stderr we can attach to the thrown error.
const RASTER_CHILD = `
import { createRequire } from "node:module";
const req = createRequire(process.env.FLUX_RESVG_FROM);
const { Resvg } = req("@resvg/resvg-js");
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const r = new Resvg(Buffer.concat(chunks).toString("utf8"), {
  fitTo: { mode: "zoom", value: Number(process.env.FLUX_RESVG_SCALE) || 1 },
});
process.stdout.write(r.render().asPng());
`;

async function rasterizePng(svg: string, scale: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", RASTER_CHILD], {
      // Resolve @resvg/resvg-js from THIS module's location — works from the
      // repo (tsx), from dist/flux-{cli,mcp}.mjs, and packaged (external dep).
      env: { ...process.env, FLUX_RESVG_FROM: import.meta.url, FLUX_RESVG_SCALE: String(scale) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const png = Buffer.concat(out);
      const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50;
      if (code === 0 && isPng) return resolve(png);
      // Surface the MESSAGE, not node's stack/version noise: prefer the first
      // "Error:"/panic line, else the first non-frame line.
      const lines = Buffer.concat(err).toString("utf8").split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("at ") && !/^Node\.js v/.test(l));
      const detail = lines.find((l) => /error|panic/i.test(l)) ?? lines[0] ?? "";
      reject(new Error(`rasterization failed (resvg exit ${code}${isPng ? "" : ", no PNG produced"})${detail ? ": " + detail : ""}`));
    });
    child.stdin.on("error", () => {}); // child died before reading — close() reports it
    child.stdin.end(svg);
  });
}

/** Best-effort bisect after a failed figure rasterization: re-render the figure
 *  with each plot panel alone (in its composed nested-<svg> context — panels
 *  that render fine standalone can still panic under compose scaling) and
 *  report the ones that fail. Each culprit's asset SVG is then scanned for
 *  extreme coordinates so the error names the semantic id and value that broke
 *  the renderer, not just the panel file (moma feedback #7). */
async function findUnrenderablePanels(root: string, figId: string): Promise<string[]> {
  const culprits: string[] = [];
  try {
    const index = await readFigIndex(root);
    if (!index) return [];
    const { byId } = await readCanvasFiles(root, index);
    const fig = byId[figId];
    if (!fig) return [];
    const assets = new Map((index.assets ?? []).map((a) => [a.id, a] as const));
    for (const el of fig.elements.filter((e) => e.type === "plot")) {
      try {
        await rasterizePng(await renderFigureSvg(root, figId, { onlyElement: el.id }), 1);
      } catch {
        const aid = (el as { assetId?: string }).assetId;
        const asset = aid ? assets.get(aid) : undefined;
        let detail = "";
        if (asset?.path) {
          const text = await fs.readFile(j(root, "fig", asset.path), "utf8").catch(() => null);
          // Report-only scan at a LOWER threshold than the import clamp (4× the
          // canvas vs 64×): rendering already failed, so moderately-outside
          // geometry is worth naming even though import would leave it alone.
          const scan = text ? scanAbsurdPathCoords(text, { clamp: false, thresholdFactor: 4 }) : null;
          if (scan?.clamped) {
            const worst = scan.values
              .slice(0, 2)
              .map((v) => (Number.isNaN(v) ? "non-finite" : Math.round(v).toLocaleString("en-US")))
              .join(", ");
            const where = scan.ids.length ? ` near "${scan.ids[0]}"` : "";
            detail = ` — ${scan.clamped} extreme coordinate(s) (worst: ${worst})${where}; regenerate the plot with sane geometry (log-axis bars: anchor at 1) or run flux sync-figure to re-clamp`;
          }
        }
        culprits.push(`${el.id}${asset ? ` (${asset.name ?? aid})` : ""}${detail}`);
      }
    }
  } catch {
    /* diagnosis is best-effort — never mask the original error */
  }
  return culprits;
}

/** render-figure → a rasterized PNG (resvg in a child process; no browser).
 *  `scale` is a zoom factor over the figure's world units (default 2 ≈ 144dpi).
 *  On failure the error names the offending panel(s) when a bisect finds them. */
export async function renderFigurePng(root: string, id: string, scale = 2): Promise<Buffer> {
  const svg = await renderFigureSvg(root, id);
  try {
    return await rasterizePng(svg, scale);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const culprits = await findUnrenderablePanels(root, id);
    throw new Error(
      `render-figure ${id}: ${msg}` +
        (culprits.length ? ` — offending panel(s): ${culprits.join(", ")}` : ""),
    );
  }
}

const escXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** render-canvas → one SVG of a whole canvas: every figure rendered in place
 *  at its canvas x/y, with a muted name·id label above each frame. This is the
 *  canvas-level "look" verb — `render-figure` shows one frame in isolation, so
 *  a headless agent could never see figures stacked on top of each other. */
export async function renderCanvasSvg(root: string, canvasId?: string): Promise<{ svg: string; canvasId: string }> {
  await requireProject(root);
  const index = await readFigIndex(root);
  if (!index) throw new Error("no fig/index.json (run `flux reindex` or open the project once)");
  const cid = canvasId ?? index.canvases?.[0]?.id;
  if (!cid || (canvasId && !(index.canvases ?? []).some((c) => c.id === canvasId)))
    throw new Error(`canvas not found: ${canvasId ?? "(none in index)"}`);
  const { byId } = await readCanvasFiles(root, index);
  const figs = (index.figures ?? [])
    .filter((f) => f.canvas === cid && byId[f.id])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((f) => byId[f.id]);
  if (!figs.length) throw new Error(`canvas ${cid} has no figures`);

  const LABEL_H = 26;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of figs) {
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y - LABEL_H);
    x1 = Math.max(x1, f.x + f.width);
    y1 = Math.max(y1, f.y + f.height);
  }
  const pad = 40;
  const vx = x0 - pad, vy = y0 - pad, vw = x1 - x0 + 2 * pad, vh = y1 - y0 + 2 * pad;

  const parts: string[] = [];
  for (const f of figs) {
    const svg = await renderFigureSvg(root, f.id);
    // Nest the figure's own render at its canvas position (nested <svg x y>).
    parts.push(
      `<text x="${f.x}" y="${f.y - 8}" font-family="sans-serif" font-size="16" fill="#8a8279">` +
        `${escXml(f.name)} · ${escXml(f.id)}</text>`,
    );
    parts.push(svg.replace("<svg ", `<svg x="${f.x}" y="${f.y}" `));
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}">\n` +
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#ffffff"/>\n` +
    parts.join("\n") +
    `\n</svg>`;
  return { svg, canvasId: cid };
}

/** render-canvas → PNG. Default scale 1: a whole canvas is several figures
 *  tall, and 2× would produce a needlessly huge raster for a look-step. On
 *  failure, each figure is rendered alone so the error names WHICH figure
 *  (and via the panel bisect, which panel/coordinate) broke the canvas. */
export async function renderCanvasPng(root: string, canvasId?: string, scale = 1): Promise<{ png: Buffer; canvasId: string }> {
  const { svg, canvasId: cid } = await renderCanvasSvg(root, canvasId);
  try {
    return { png: await rasterizePng(svg, scale), canvasId: cid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail: string[] = [];
    try {
      const index = await readFigIndex(root);
      for (const f of (index?.figures ?? []).filter((f) => f.canvas === cid)) {
        await renderFigurePng(root, f.id, 1).catch((fe) => {
          detail.push(fe instanceof Error ? fe.message : String(fe));
        });
      }
    } catch {
      /* best-effort */
    }
    throw new Error(`render-canvas ${cid}: ${msg}` + (detail.length ? `\n  ${detail.join("\n  ")}` : ""));
  }
}

/** Write fig/renders/<id>.svg for every figure embedded in `docPath` (or every project
 *  figure when the doc can't be read). Quarto reads these from DISK — the GUI preview
 *  and in-app PDF inline from memory, so nothing else keeps renders/ fresh (gitignored
 *  derived state; W8 deliberately keeps MB-scale renders off the autosave path). */
export async function materializeRenders(
  root: string,
  docPath?: string,
): Promise<{ wrote: number; failed: string[]; warnings: string[] }> {
  const failed: string[] = [];
  const warnings: string[] = [];
  let wrote = 0;
  const index = await readFigIndex(root);
  if (!index) return { wrote, failed, warnings };
  const known = new Set(index.figures.map((f) => f.id));
  let ids = new Set<string>(known);
  if (docPath) {
    try {
      const src = await fs.readFile(safeJoin(root, docPath), "utf8");
      const embedded = new Set<string>();
      const re = /^\s*!\[.*?\]\(([^)]*)\)\{#(fig-[A-Za-z0-9_-]+)[^}]*\}\s*$/;
      for (const line of src.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        const fromPath = /fig\/renders\/([A-Za-z0-9_-]+)\.svg$/.exec(m[1]);
        if (fromPath && known.has(fromPath[1])) embedded.add(fromPath[1]);
      }
      if (embedded.size) ids = embedded;
    } catch {
      /* unreadable doc → render all known figures (safe superset) */
    }
  }
  await fs.mkdir(safeJoin(root, "fig/renders"), { recursive: true });
  // WS-12: name any figure whose text a headless edit left unwrapped — the
  // materialized SVGs are exactly what the compiled manuscript will show.
  warnings.push(...(await textLayoutProbe(root, { figureIds: [...ids] })));
  for (const id of ids) {
    try {
      const svg = await renderFigureSvg(root, id);
      await atomicWrite(safeJoin(root, `fig/renders/${id}.svg`), svg);
      wrote++;
    } catch {
      failed.push(id);
    }
  }
  return { wrote, failed, warnings };
}
