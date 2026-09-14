import { fileBridge, type FileBridge } from "../project/types";
import { plotKeyFor } from "../dissect/rules";

export interface GalleryPreviewFile { abs: string; name: string; rel?: string; video?: boolean }
export function galleryDissectionKey(file: GalleryPreviewFile, root: string): string {
  return plotKeyFor(file.abs, root);
}
export function isGalleryVideo(file: GalleryPreviewFile): boolean { return !!file.video || /\.(mp4|mov)$/i.test(file.name); }

/** Videos stay in the native range streamer; previewing never imports, copies,
 * or reads an entire recording into the renderer. The caller owns release. */
export async function openGalleryVideo(root: string, file: GalleryPreviewFile, bridge: FileBridge | null | undefined = fileBridge()) {
  if (!bridge?.videoGalleryUrl) throw new Error("Video playback is available in the desktop app.");
  const url = await bridge.videoGalleryUrl({ root, path: file.abs });
  let released = false;
  return { url, release() {
    if (released) return;
    released = true;
    void bridge.releaseVideoGalleryUrl?.(url).catch(() => {});
  } };
}
