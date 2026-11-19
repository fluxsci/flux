/**
 * A Plots-rail / Plot-gallery picture of an image bundle under the project's `plots/` (thumbClient.ts asks; loaded
 * lazily, so the rail itself never pulls in the decoding machinery).
 *
 * Only a tile that is on screen asks, through the thumbnail client's bounded queue. The bundle's manifest is read
 * (by a decode worker, through `readFluximg`; never a `file://` URL) to describe the image, then the picture is the
 * bundle's own `preview.png` when it has one, else a small still drawn by the reference renderer in the worker pool
 * at the tile's bucket. A rewritten bundle (a new index stamp) drops what the service knew about the old one first.
 */
import { get } from "svelte/store";
import { embeddedProjectRoot, projectDir } from "../store";
import { fileBridge } from "../project/types";
import { fluximgService } from "./store";
import { describeFluximg, fluximgInfo } from "./place";
import { noteFluximgRailFact } from "./railFacts";
import { pngInfo, FLUXIMG_PREVIEW_NAME } from "../plotsRail/rules";

/** A preview.png larger than this is not worth reading for a tile (the spec caps it at 512 px; a still is cheaper). */
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
/** The stamp each bundle was last described at: a new one means its files were rewritten. */
const stampOf = new Map<string, string>();

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** `plots/…/x.fluximg` for a bundle inside this project's plots folder, else null. */
export function projectBundleRel(abs: string, root: string): string | null {
  const a = slash(abs), r = slash(root);
  if (!r || !a.startsWith(`${r}/plots/`)) return null;
  const rel = a.slice(r.length + 1);
  return rel.split("/").some((s) => s === ".." || s === ".") ? null : rel;
}

export interface FluximgRailPicture {
  /** PNG bytes (a preview.png) — or `url`, a PNG data URL (a still). */
  bytes?: Uint8Array;
  url?: string;
  width: number;
  height: number;
}

/** The picture for one tile of a bundle at `abs`, version `stamp`, at most `bucket` px on its longer side. */
export async function fluximgRailThumb(abs: string, stamp: string, bucket: number): Promise<FluximgRailPicture> {
  const root = get(embeddedProjectRoot) ?? get(projectDir) ?? "";
  const bundle = projectBundleRel(abs, root);
  if (!bundle) throw new Error("Image bundles are shown from this project's plots folder");
  const svc = fluximgService();
  const was = stampOf.get(bundle);
  if (was !== undefined && was !== stamp) svc.forget(bundle);
  stampOf.set(bundle, stamp);
  if (stampOf.size > 4000) stampOf.delete(stampOf.keys().next().value!);

  const manifest = await svc.manifest(bundle);
  const info = fluximgInfo(manifest);
  const nd = info.shape.length, W = info.shape[nd - 1], H = info.shape[nd - 2];
  noteFluximgRailFact(abs, { stamp, line: describeFluximg(info), width: W, height: H });

  const bridge = fileBridge();
  try {
    if (bridge?.readFluximg) {
      // The index's stat already said whether there is a preview; its size decides whether it is worth reading.
      const st = await bridge.stat?.(`${slash(abs)}/${FLUXIMG_PREVIEW_NAME}`).catch(() => null);
      if (st && st.size > 0 && st.size <= PREVIEW_MAX_BYTES) {
        const bytes = new Uint8Array(await bridge.readFluximg({ root, bundle, path: FLUXIMG_PREVIEW_NAME, offset: 0, length: -1 }));
        const px = pngInfo(bytes);
        if (px) return { bytes, width: px.width, height: px.height };
      }
    }
  } catch { /* no preview.png (or unreadable): draw a still instead */ }

  const k = Math.min(1, Math.max(16, bucket) / Math.max(W, H));
  const outWidth = Math.max(1, Math.round(W * k)), outHeight = Math.max(1, Math.round(H * k));
  // The key starts with the bundle so `forget(bundle)` drops it with the rest of the bundle's stills.
  const url = await svc.still(`${bundle}|rail|${stamp}|${outWidth}x${outHeight}`, { bundle, view: null, crop: null, outWidth, outHeight });
  return { url, width: outWidth, height: outHeight };
}
