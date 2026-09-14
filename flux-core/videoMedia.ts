/** Shared native media preparation; model edits remain in slides.ts's lock. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Asset } from "../src/lib/types";

export interface PreparedVideo { asset: Asset; posterAsset: Asset; poster: string }
export interface PrepareVideoOptions {
  root: string; deckId: string; sourcePath: string; encoder?: string; signal?: AbortSignal;
  onProgress?: (progress: { phase: "encoding" | "finalizing"; percent: number }) => void;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function native() {
  const appRoot = process.env.FLUX_VIDEO_APP_ROOT || path.resolve(here, "..");
  return require(path.join(appRoot, "electron/videoMedia.cjs")) as {
    prepareVideo(options: PrepareVideoOptions): Promise<PreparedVideo>;
    cleanupPrepared(root: string, deckId: string, result: PreparedVideo): Promise<void>;
  };
}
export function prepareVideo(options: PrepareVideoOptions): Promise<PreparedVideo> { return native().prepareVideo(options); }
export function cleanupPrepared(root: string, deckId: string, result: PreparedVideo): Promise<void> { return native().cleanupPrepared(root, deckId, result); }
