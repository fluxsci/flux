// flux-core/snips.ts — headless paper snips: rasterize a region of a FluxLib
// paper's PDF page to a PNG in <project>/plots/paper_snips/, with the same
// provenance the GUI writes (pHYs true-size dpi + flux-snip tEXt chunk +
// .snip.json sidecar) and the same naming/citation, via the shared pure core
// (src/lib/references/snips.ts — twin-engine §2; only the pixel encoder
// differs per engine, by design).
//
// pdf.js legacy + @napi-rs/canvas are imported lazily: both are marked external
// in scripts/build-cli.mjs, and the canvas .node binary can't ship in the
// packaged bundle — from a checkout/npx everything works; packaged, the verb
// fails with an actionable ExternalToolError instead of crashing the bundle.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "node:fs";
import * as path from "node:path";
import { hasPdf, readPdf } from "./items";
import { supplementsDir } from "../src/lib/references/items";
import { resolveFluxLibPath, loadIndex } from "./fluxlib";
import { atomicWrite } from "./fsx";
import { NotFoundError, ExternalToolError } from "./errors";
import { injectPngDpi, injectPngText } from "../src/lib/figure/pngDpi";
import { inTextAuthorYear } from "../src/lib/references/format";
import {
  SNIP_DIR,
  SNIP_SCALE,
  SNIP_TEXT_KEYWORD,
  composeSnipCitation,
  defaultSnipName,
  sanitizeSnipName,
  dedupSnipName,
  normSnipRect,
  snipRasterPlan,
  encodeSnipMeta,
  sidecarText,
  type SnipMeta,
  type SnipRect,
} from "../src/lib/references/snips";

let _getDocument: any = null;
async function getDocument(opts: any): Promise<any> {
  if (!_getDocument) {
    try {
      ({ getDocument: _getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"));
    } catch (e) {
      throw new ExternalToolError(
        `PDF rasterization needs pdfjs-dist with a native canvas (@napi-rs/canvas) — run flux from a checkout/npx, not the packaged bundle (${(e as Error).message})`,
      );
    }
  }
  return _getDocument(opts);
}

async function loadCanvas(): Promise<any> {
  try {
    return await import("@napi-rs/canvas");
  } catch (e) {
    throw new ExternalToolError(
      `PDF rasterization needs @napi-rs/canvas — run flux from a checkout/npx, not the packaged bundle (${(e as Error).message})`,
    );
  }
}

export interface SnipPaperOpts {
  key: string;
  page: number;
  /** PDF points, y-up, [x1,y1,x2,y2] — the GUI marquee/sidecar contract. Omit = whole page. */
  rect?: SnipRect;
  name?: string;
  scale?: number;
  /** Snip a supplement PDF (items/<key>/supplements/<name>) instead of paper.pdf. */
  supplement?: string;
  /** FluxLib override (tests) — defaults to the resolved machine FluxLib. */
  libPath?: string;
}

export interface SnipPaperResult {
  path: string; // project-relative PNG path
  name: string;
  citation: string;
  page: number;
  rect: SnipRect;
  dpi: number;
  /** False when the key has no FluxLib bib entry (citation fell back to the citekey). */
  bibEntry: boolean;
}

/** Capture a page region of a paper's PDF as a provenance-carrying PNG snip. */
export async function snipPaper(root: string, opts: SnipPaperOpts): Promise<SnipPaperResult> {
  const lib = opts.libPath ? path.resolve(opts.libPath) : await resolveFluxLibPath();
  const scale = opts.scale && opts.scale > 0 ? Math.min(opts.scale, 8) : SNIP_SCALE;

  // --- source PDF bytes (main paper or a named supplement) -------------------------
  let bytes: Uint8Array;
  if (opts.supplement) {
    const p = path.join(supplementsDir(lib, opts.key), opts.supplement);
    if (!fs.existsSync(p)) throw new NotFoundError(`no supplement "${opts.supplement}" for @${opts.key}`);
    bytes = new Uint8Array(await fs.promises.readFile(p));
  } else {
    if (!(await hasPdf(opts.key, lib))) throw new NotFoundError(`no PDF for @${opts.key} (fetch-pdfs or ingest-pdf first)`);
    const buf = await readPdf(opts.key, lib);
    if (!buf) throw new NotFoundError(`no PDF for @${opts.key}`);
    // pdf.js detaches the buffer it's handed — always pass a fresh copy (fulltext.ts lesson).
    bytes = new Uint8Array(buf);
  }

  // --- bib entry → citation (never a hard failure) ---------------------------------
  const idx = await loadIndex(lib);
  const entry = idx.entries[opts.key] ?? null;
  const citation = composeSnipCitation(entry, opts.key);

  // --- render the region (same viewport call sequence as PdfView.renderRegion) -----
  const { createCanvas } = await loadCanvas();
  const task = await getDocument({
    data: bytes,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  } as any);
  let png: Uint8Array;
  let rect: SnipRect;
  try {
    const doc = await task.promise;
    if (opts.page < 1 || opts.page > doc.numPages) {
      throw new NotFoundError(`page ${opts.page} out of range (1–${doc.numPages})`);
    }
    const page = await doc.getPage(opts.page);
    const pageBox = page.view as SnipRect;
    rect = normSnipRect(opts.rect ?? pageBox, pageBox);
    if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) {
      throw new NotFoundError(`rect [${(opts.rect ?? []).join(",")}] is empty after clamping to the page box [${pageBox.join(",")}]`);
    }
    const plan = snipRasterPlan(rect, scale);
    const vp = page.getViewport({ scale });
    const [vx, vy] = vp.convertToViewportPoint(rect[0], rect[3]); // region's top-left (y-up → top edge is y2)
    const canvas = createCanvas(plan.widthPx, plan.heightPx);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, plan.widthPx, plan.heightPx);
    await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -vx, -vy] }).promise;
    page.cleanup();
    png = new Uint8Array(await canvas.encode("png"));
  } finally {
    await task.destroy();
  }

  // --- provenance + write (shared naming/meta; atomic like every canonical write) --
  const meta: SnipMeta = {
    citekey: opts.key,
    page: opts.page,
    rect,
    sourcePdf: opts.supplement ? { supplement: opts.supplement } : "main",
    capturedAt: new Date().toISOString(),
    citation,
  };
  png = injectPngDpi(png, snipRasterPlan(rect, scale).dpi);
  png = injectPngText(png, SNIP_TEXT_KEYWORD, encodeSnipMeta(meta));

  const dir = path.join(root, ...SNIP_DIR.split("/"));
  await fs.promises.mkdir(dir, { recursive: true });
  const base = (opts.name && sanitizeSnipName(opts.name)) || defaultSnipName(opts.key, opts.page);
  const name = await dedupSnipName(base, async (n) => fs.existsSync(path.join(dir, `${n}.png`)));
  await atomicWrite(path.join(dir, `${name}.png`), png);
  await atomicWrite(path.join(dir, `${name}.snip.json`), sidecarText(meta));

  return {
    path: `${SNIP_DIR}/${name}.png`,
    name,
    citation,
    page: opts.page,
    rect,
    dpi: snipRasterPlan(rect, scale).dpi,
    bibEntry: !!entry,
  };
}

export interface CitationResult {
  key: string;
  citation: string;
  inText: string;
  journal: string | null;
  bibEntry: boolean;
}

/** The minimal text citation for a FluxLib key ("Smith et al., 2026, Nat. Neurosci."). */
export async function getCitation(key: string, libPath?: string): Promise<CitationResult> {
  const idx = await loadIndex(libPath ?? (await resolveFluxLibPath()));
  const entry = idx.entries[key] ?? null;
  return {
    key,
    citation: composeSnipCitation(entry, key),
    inText: entry ? inTextAuthorYear(entry) : key,
    journal: entry?.container ?? null,
    bibEntry: !!entry,
  };
}
