/**
 * flux-core's fluximg stills: the Node side of `src/lib/fluximg/exportStatic.ts`.
 *
 * A placed image's bundle (`<project>/fig/assets/<id>.fluximg`) is opened with the pure reader over `fs`, drawn by
 * `still.renderStill` (THE one renderer: the window's workers call the same function), encoded as PNG on
 * `node:zlib`, and handed to the pure composer, which emits `static.fluximgStaticSvg` with the still as a data URL.
 * No Electron and no browser: the reference renderer is plain TypeScript.
 *
 * A missing or unreadable bundle never fails a figure render: the element draws its stand-in and the reason goes
 * to the render's warnings, the way a 3D model without a poster does.
 */
import fs from "node:fs/promises";
import type { Asset, Figure } from "../src/lib/types";
import { openFluximg, type FluximgReader } from "../src/lib/fluximg/reader";
import { renderStill } from "../src/lib/fluximg/still";
import { colormapLut, ensureColormapLuts } from "../src/lib/color/colormapLuts";
import {
  prepareFluximgContext, visibleFluximgElements, fluximgBundlePath,
  type FluximgExportIO, type FluximgExportSurface, type FluximgStillRequest, type FluximgSvgContext,
} from "../src/lib/fluximg/exportStatic";
import { nodeBundleReader, nodeZstd } from "./fluximgIo";
import { pngDataUrl } from "./fluximgPng";
import { projectAssetPath } from "./model";

/** Readers kept for one render (a figure, a canvas, a materialize run): each bundle is opened once. */
export interface FluximgRenderSession {
  readers: Map<string, Promise<FluximgReader>>;
}
export function fluximgRenderSession(): FluximgRenderSession {
  return { readers: new Map() };
}

/**
 * A colour map's 256 entries, or null when the name is unknown: exactly the window workers' resolver, so an unknown
 * map falls back the way `lut.channelTable` documents (the gray ramp) in both engines. Load the tables first
 * (`ensureColormapLuts`); before that every name is unknown.
 */
export const resolveFluximgLut = (name: string): string[] | null => colormapLut(name)?.lut ?? null;

async function bundleDir(root: string, asset: Asset): Promise<string> {
  const rel = fluximgBundlePath(asset);
  let dir: string;
  try { dir = await projectAssetPath(root, rel); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`its bundle ${rel} is missing`);
    throw error;
  }
  if (!(await fs.stat(dir)).isDirectory()) throw new Error(`its bundle ${rel} is not a folder`);
  return dir;
}

/** The reader of a placed asset's bundle, opened once per session. A failure is not kept: the next render retries. */
export function fluximgReader(root: string, asset: Asset, session: FluximgRenderSession = fluximgRenderSession()): Promise<FluximgReader> {
  const key = `${asset.id}|${asset.path}`;
  let r = session.readers.get(key);
  if (!r) {
    r = (async () => {
      const dir = await bundleDir(root, asset);
      try { return await openFluximg(nodeBundleReader(dir), await nodeZstd()); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`its bundle ${fluximgBundlePath(asset)} has no fluximg.json`);
        throw error;
      }
    })();
    r.catch(() => session.readers.delete(key));
    session.readers.set(key, r);
  }
  return r;
}

/** Draw one still request and encode it: the PNG data URL the composer embeds. */
export async function renderFluximgStillUrl(reader: FluximgReader, request: Pick<FluximgStillRequest, "view" | "crop" | "outWidth" | "outHeight">): Promise<string> {
  await ensureColormapLuts();
  const s = await renderStill(reader, { view: request.view, crop: request.crop, outWidth: request.outWidth, outHeight: request.outHeight }, { resolveLut: resolveFluximgLut });
  return pngDataUrl(s.rgba, s.width, s.height);
}

/** flux-core's IO for the pure composer. */
export function nodeFluximgIO(root: string, session: FluximgRenderSession = fluximgRenderSession()): FluximgExportIO {
  return {
    manifest: async (asset) => (await fluximgReader(root, asset, session)).manifest,
    still: async (asset, request) => renderFluximgStillUrl(await fluximgReader(root, asset, session), request),
    text: async (asset, path) => (await fluximgReader(root, asset, session)).readText(path),
    table: async (asset, path) => (await fluximgReader(root, asset, session)).readTable(path),
  };
}

export interface ResolveFluximgOptions {
  /** The output: `{kind: "raster", dpi}` for PNG, `svg` / `pdf` / `figure` for vector outputs (300 dpi). */
  surface?: FluximgExportSurface;
  warnings?: string[];
  session?: FluximgRenderSession;
  namespace?: string;
  signal?: AbortSignal;
}

/**
 * Everything the figures' fluximg elements need for one output, or undefined when they have none. Problems become
 * warnings (one per element) and those elements draw their stand-in; this never throws for a bad bundle.
 */
export async function resolveFluximgContext(root: string, figures: readonly Figure[], assets: readonly Asset[], options: ResolveFluximgOptions = {}): Promise<FluximgSvgContext | undefined> {
  if (!visibleFluximgElements(figures).length) return undefined;
  await ensureColormapLuts();
  return prepareFluximgContext(figures, assets, nodeFluximgIO(root, options.session), {
    surface: options.surface ?? "figure", namespace: options.namespace,
    onIssue: (_e, message) => options.warnings?.push(message),
    isCurrent: options.signal ? () => !options.signal!.aborted : undefined,
  });
}
