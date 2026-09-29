import { resolveModelPosters, type ModelPosterPolicy, type ResolvedModelPosters } from './model3dPosterCache';
import type { PosterSurface } from '../src/lib/model3d/poster';
import type { FigIndexFile } from '../src/lib/project/figfiles';
import { elementAssetRefs } from "../src/lib/model3d/refs";
import { mimeFor } from "../src/lib/assets";
// flux-core/render.ts — headless figure/canvas rendering (split out of
// index.ts; WS-6.2): standalone SVG via the GUI's figureToSvg (semantic-plot
// overrides baked in), PNG via resvg in a child process, whole-canvas looks,
// and the fig/renders/ materialization Quarto reads from disk.

import * as fs from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { figureToSvg } from "../src/lib/export";
import { buildPlotMarkup } from "../src/lib/plot/inlineMarkup";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import { isUnderRoot, plotSourceCandidates } from "../src/lib/plot/source";
import type { Asset, Figure, Project } from "../src/lib/types";
import { normalizeIndexAssets } from "../src/lib/project/figfiles";
import { migrateProject } from "../src/lib/migrate";
import * as ops from "../src/lib/ops";
import { atomicWrite } from "./fsx";
import { j } from "./journal";
import { requireProject, projectAssetPath, safeJoin, exists, readFigIndex, readCanvasFiles } from "./model";
import { scanAbsurdPathCoords } from "./coordscan";

/** Optional sidecars may be absent, but unreadable, corrupt or escaping
 * stored project metadata must not silently change semantic export output. */
async function readPlotManifest(root: string, rel: string): Promise<FluxPlotManifest | undefined> {
  try { return JSON.parse(await fs.readFile(await projectAssetPath(root, rel), "utf8")) as FluxPlotManifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}


/** Bytes needed by image rendering. Model and media payloads never enter this set. */
export function figureImageAssetIds(fig: Pick<Figure, "elements">): Set<string> {
  return new Set(fig.elements.flatMap(element => { const refs = elementAssetRefs(element); return [...refs.images, ...refs.posterRefs]; }));
}

// Headless DOM (linkedom) so the shared plot pipeline (plot/inlineMarkup.ts →
// preparePlot/prefixIds/applyOverrides/compensatePtTrue) runs exactly like the
// in-app render, one source of truth. Exported for slides.ts (gatherDeckPayload
// derives manifests for vanilla plots through the same seam).
let domReady = false;
export async function ensureDom(): Promise<void> {
  if (domReady) return;
  const { DOMParser } = await import("linkedom");
  const g = globalThis as unknown as { DOMParser?: unknown };
  if (!g.DOMParser) {
    const {DOMParser: XmlParser}=await import("@xmldom/xmldom");
    // linkedom supplies DOM mutation/style APIs but is a tolerant HTML parser.
    // Validate XML first so headless exports refuse malformed assets like browsers.
    g.DOMParser=class {
      parseFromString(text: string, type: "text/html" | "image/svg+xml" | "text/xml") {
        if (type!=="text/html") {
          let invalid=false;
          try { new XmlParser({errorHandler:{warning:()=>{invalid=true},error:()=>{invalid=true},fatalError:()=>{invalid=true}}}).parseFromString(text,"image/svg+xml"); } catch {invalid=true;}
          if (invalid) return new DOMParser().parseFromString("<parsererror>Malformed SVG</parsererror>","text/xml");
        }
        return new DOMParser().parseFromString(text,type);
      }
    };
  }
  domReady = true;
}

/** render-figure → a standalone SVG string (reuses the GUI's figureToSvg). For
 *  semantic plots the per-part overrides are baked in (faithful to the GUI);
 *  image/svg assets are inlined as data URLs. */
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

export interface Model3dRenderOptions {
  model3dPolicy?: ModelPosterPolicy;
  posterSurface?: PosterSurface;
  warnings?: string[];
  signal?: AbortSignal;
}
interface LoadedRender { index: FigIndexFile; byId: Record<string, Figure>; assets: Asset[]; models?: ResolvedModelPosters }
async function loadRender(root: string): Promise<LoadedRender> {
  await requireProject(root);
  const index = await readFigIndex(root);
  if (!index) throw new Error('no fig/index.json (run `flux reindex` or open the project once)');
  const { byId } = await readCanvasFiles(root, index);
  const assets: Asset[] = normalizeIndexAssets(index).map(asset => ({ ...asset, name: asset.name ?? asset.id, path: asset.path ?? '', naturalWidth: asset.naturalWidth ?? 0, naturalHeight: asset.naturalHeight ?? 0 }));
  return { index, byId, assets };
}
export async function renderFigureSvg(
  root: string,
  id: string,
  opts: Model3dRenderOptions & { groupId?: string; onlyElement?: string } = {},
  loaded?: LoadedRender,
): Promise<string> {
  const snapshot = loaded ?? await loadRender(root), { index, byId } = snapshot;
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
    assets: snapshot.assets,
    palette: [],
  };
  migrateProject(renderProject);

  const assetCache: Record<string, string> = {};
  const assetPath: Record<string, string> = {};
  const required = figureImageAssetIds(fig);
  const models = snapshot.models ?? await resolveModelPosters(root, [fig], snapshot.assets, {
    policy: opts.model3dPolicy ?? 'image', surface: opts.posterSurface ?? 'figure', allFigures: Object.values(byId), signal: opts.signal,
  });
  if (!snapshot.models) opts.warnings?.push(...models.warnings);
  Object.assign(assetCache, models.urls);
  for (const a of normalizeIndexAssets(index)) {
    if (!required.has(a.id)) continue;
    if (!a.path) throw new Error(`Missing asset path: ${a.id}`);
    assetPath[a.id] = a.path;
    const ap = await projectAssetPath(root, `fig/${a.path}`);
    if (await exists(ap)) {
      const bytes = await fs.readFile(ap);
      assetCache[a.id] = `data:${mimeFor(a.kind)};base64,${bytes.toString("base64")}`;
    }
  }

  for (const id of required) if (!assetCache[id]) throw new Error(`Missing figure asset ${id}`);

  // Build faithful inline markup for each semantic plot element.
  const plotMarkup = new Map<string, string>();
  const plots = fig.elements.filter((e) => e.type === "plot");
  if (plots.length) {
    await ensureDom();
    for (const el of plots) {
      const rel = assetPath[(el as { assetId: string }).assetId];
      if (!rel) throw new Error(`Missing plot asset: ${el.id}`);
      const svgText = await fs.readFile(await projectAssetPath(root, `fig/${rel}`), "utf8");
      if (!svgText) throw new Error(`Empty plot asset: ${el.id}`);
      let manifest: FluxPlotManifest | undefined;
      // Prefer the asset-local sidecar (always in-root, written on import/save) —
      // then fall back to the original source manifest for older projects. AGT-11:
      // source.manifestPath can point outside root (plot imported from elsewhere),
      // where safeJoin throws; the asset-local copy avoids that entirely.
      const aid = (el as { assetId?: string }).assetId;
      if (aid) manifest = await readPlotManifest(root, `fig/assets/${aid}.fluxplot.json`);
      const src = (el as { source?: { manifestPath?: string } }).source;
      if (!manifest && src?.manifestPath) {
        // Probe every shape source.manifestPath takes (plot/source.ts), but keep
        // safeJoin's guarantee: a canvas file is untrusted input here, so only
        // candidates lexically AND canonically under root are read. That gains the
        // re-anchor rescue — a foreign absolute path from another machine
        // resolves against this root instead of silently yielding no manifest.
        for (const cand of plotSourceCandidates(root, src.manifestPath)) {
          if (!isUnderRoot(root, cand)) continue;
          // POSIX: readPlotManifest validates its argument as a STORED asset
          // path, and a stored path never contains a backslash. path.relative
          // hands back `plotssource.fluxplot.json` on Windows, which the
          // guard rejected — so a figure rendered headlessly there lost every
          // semantic manifest instead of loading it (2026-09-22).
          manifest = await readPlotManifest(root, relative(root, cand).split(sep).join("/"));
          if (manifest) break;
        }
      }
      const markup = buildPlotMarkup(
        svgText,
        el as Parameters<typeof buildPlotMarkup>[1],
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
    { ...opts, model3d: models.context },
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
const width = Number(process.env.FLUX_RESVG_WIDTH) || 0;
const r = new Resvg(Buffer.concat(chunks).toString("utf8"), {
  fitTo: width
    ? { mode: "width", value: width }
    : { mode: "zoom", value: Number(process.env.FLUX_RESVG_SCALE) || 1 },
});
process.stdout.write(r.render().asPng());
`;

async function rasterizePng(svg: string, scale: number, width = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", RASTER_CHILD], {
      // Electron-as-Node cannot read asar. Resolve beside the unpacked CLI/MCP
      // and its shipped @resvg packages; source and ordinary dist stay unchanged.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        FLUX_RESVG_FROM: pathToFileURL(fileURLToPath(import.meta.url)
          .replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")).href,
        FLUX_RESVG_SCALE: String(scale),
        FLUX_RESVG_WIDTH: String(width),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const png = Buffer.concat(out);
      const isPng = png.length > 8 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
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

/** Rasterize arbitrary SVG text to PNG at an exact pixel width — the headless
 *  counterpart of the renderer's canvas rasterizer, used to give a .docx's SVG
 *  pictures the raster fallback Word requires (docxSvgFallback.ts).
 *
 *  Rides the same out-of-process resvg child as every other rasterization here, so a
 *  pathological SVG cannot take the CLI down with it. Source, dist and packaged
 *  CLI/MCP installs all use this same child and their local resvg prebuilt. Callers treat a
 *  throw as "no fallback for this picture" and carry on. */
export async function rasterizeSvgToPng(svg: string, width: number): Promise<Buffer> {
  return rasterizePng(svg, 1, Math.max(1, Math.round(width)));
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
        await rasterizePng(await renderFigureSvg(root, figId, { onlyElement: el.id, model3dPolicy: 'collect' }), 1);
      } catch {
        const aid = (el as { assetId?: string }).assetId;
        const asset = aid ? assets.get(aid) : undefined;
        let detail = "";
        if (asset?.path) {
          const text = await fs.readFile(await projectAssetPath(root, `fig/${asset.path}`), "utf8").catch(() => null);
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
export async function renderFigurePng(root: string, id: string, scale = 2, opts: Model3dRenderOptions = {}): Promise<Buffer> {
  const svg = await renderFigureSvg(root, id, { ...opts, posterSurface: opts.posterSurface ?? { kind: 'raster', dpi: 96 * scale } });
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
export async function renderCanvasSvg(root: string, canvasId?: string, opts: Model3dRenderOptions = {}): Promise<{ svg: string; canvasId: string }> {
  const snapshot = await loadRender(root), { index, byId } = snapshot;
  const cid = canvasId ?? index.canvases?.[0]?.id;
  if (!cid || (canvasId && !(index.canvases ?? []).some((c) => c.id === canvasId)))
    throw new Error(`canvas not found: ${canvasId ?? "(none in index)"}`);
  const figs = (index.figures ?? [])
    .filter((f) => f.canvas === cid && byId[f.id])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((f) => byId[f.id]);
  if (!figs.length) throw new Error(`canvas ${cid} has no figures`);
  // One batched poster resolution (one worker spawn) for the canvas. Should it
  // fail outright, each figure resolves its own models inside its own try below.
  try {
    snapshot.models = await resolveModelPosters(root, figs, snapshot.assets, { policy: opts.model3dPolicy ?? 'image', surface: opts.posterSurface ?? 'figure', allFigures: Object.values(byId), signal: opts.signal });
    opts.warnings?.push(...snapshot.models.warnings);
  } catch (error) {
    opts.signal?.throwIfAborted();
    opts.warnings?.push(`3D posters for canvas ${cid} could not be resolved together; resolving per figure: ${error instanceof Error ? error.message : String(error)}`);
  }

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
    // Nest the figure's own render at its canvas position (nested <svg x y>).
    parts.push(
      `<text x="${f.x}" y="${f.y - 8}" font-family="sans-serif" font-size="16" fill="#8a8279">` +
        `${escXml(f.name)} · ${escXml(f.id)}</text>`,
    );
    try {
      const svg = await renderFigureSvg(root, f.id, opts, snapshot);
      parts.push(svg.replace("<svg ", `<svg x="${f.x}" y="${f.y}" `));
    } catch (error) {
      // One broken figure must not blank the whole canvas look: draw a named
      // error frame in its place and say why.
      opts.signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      opts.warnings?.push(`figure "${f.id}" could not be rendered on canvas ${cid}: ${reason}`);
      parts.push(
        `<g data-figure-error="${escXml(f.id)}"><rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" fill="#fff5f2" stroke="#d14d41" stroke-dasharray="6 4"/>` +
          `<text x="${f.x + 12}" y="${f.y + 24}" font-family="sans-serif" font-size="14" fill="#af3029">Could not render: ${escXml(reason.slice(0, 160))}</text></g>`,
      );
    }
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
export async function renderCanvasPng(root: string, canvasId?: string, scale = 1, opts: Model3dRenderOptions = {}): Promise<{ png: Buffer; canvasId: string }> {
  const { svg, canvasId: cid } = await renderCanvasSvg(root, canvasId, { ...opts, posterSurface: opts.posterSurface ?? { kind: 'raster', dpi: 96 * scale } });
  try {
    return { png: await rasterizePng(svg, scale), canvasId: cid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail: string[] = [];
    try {
      const index = await readFigIndex(root);
      for (const f of (index?.figures ?? []).filter((f) => f.canvas === cid)) {
        await renderFigurePng(root, f.id, 1, { ...opts, model3dPolicy: 'collect' }).catch((fe) => {
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
  const { syncFigureAssets } = await import("./figures");
  let sources = await syncFigureAssets(root, undefined, { dryRun: true });
  if (sources.refreshed.length) sources = await syncFigureAssets(root);
  warnings.push(...sources.warnings, ...sources.missing.map((p) => `Source missing; using last saved version: ${p}`));
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
  const snapshot = await loadRender(root);
  // Batched first (one worker spawn). If that fails as a whole, every figure
  // resolves its own models inside the per-figure try, so one bad model can
  // only fail its own figure, never the compile.
  try {
    snapshot.models = await resolveModelPosters(root, [...ids].map(id => snapshot.byId[id]).filter(Boolean), snapshot.assets, { policy: 'project', surface: 'figure', allFigures: Object.values(snapshot.byId) });
    warnings.push(...snapshot.models.warnings);
  } catch (error) {
    warnings.push(`3D posters could not be resolved together; resolving per figure: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const id of ids) {
    try {
      const svg = await renderFigureSvg(root, id, { model3dPolicy: 'project', posterSurface: 'figure', warnings }, snapshot);
      await atomicWrite(safeJoin(root, `fig/renders/${id}.svg`), svg);
      wrote++;
    } catch (error) {
      failed.push(id);
      warnings.push(`figure "${id}" was not rendered: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return { wrote, failed, warnings };
}
