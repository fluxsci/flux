/**
 * The board's "Movie as MP4" key: an image's movie written as a file, from the app (fluximg stage 2, W10).
 *
 * What the key would write is planned here with the pure planner (`moviePlan.resolveMovie`): the facts the readout
 * shows on hover and the ghost on the rail. Pressing it saves what is on screen (the figure's or the slide's autosave is
 * flushed: the movie is made from the saved project, by element id, as the headless verb makes it), then the main
 * process asks where to save and runs `export-image-movie` out of process, exactly as a slide video runs; the renderer
 * only receives progress. The job is window-owned (it survives the board closing); one at a time.
 */
import { get, writable } from "svelte/store";
import { fileBridge } from "../../project/types";
import { projectModel } from "../../../shell/shellStore";
import { flushByIdChecked } from "../../../shell/lifecycle";
import { storeTenant } from "../../tenancy";
import { activeFigureId, dirty } from "../../store";
import { deckOverlay, editDestination, exitEndpointEdit, sealHistory } from "../../slide/store";
import { hasDecorationView, movieFacts, resolveMovie, type MovieSettings } from "../moviePlan";
import type { FluximgManifest } from "../types";
import type { FluximgElement } from "../element";
import { resolveView } from "../viewOps";
import { settleLiveEdit } from "./session";

export interface ImageMovieRequest {
  root: string;
  jobId: string;
  elementId: string;
  /** The image's name: the save dialog's default file name. */
  name: string;
  /** `deckId/slideId` for an image on a slide; `beatId` when the board edits a step (the image as that step leaves it). */
  slide?: string;
  beatId?: string;
  dim: string;
  from?: number;
  to?: number;
  speed?: number;
  mode?: "once" | "bounce";
}
export interface ImageMovieProgress { jobId: string; phase: "preparing" | "encoding"; frame: number; total: number }
export type ImageMovieResult =
  | { ok: true; path: string; frames: number; durationMs: number; fps: number; width: number; height: number; bytes: number; warnings: string[] }
  | { ok: false; cancelled?: boolean; error?: string };

export interface ImageMovieJob {
  id: string;
  elementId: string;
  dim: string;
  running: boolean;
  cancelling: boolean;
  /** 0..1 of the frames written (0 while the save dialog is open and the frames are planned). */
  progress: number;
  frame: number;
  total: number;
  result?: ImageMovieResult;
}

export const imageMovieJob = writable<ImageMovieJob | null>(null);

/** What the key on `dim`'s rail would write for this element (null: the image cannot play along it). */
export function movieOf(manifest: FluximgManifest, element: FluximgElement, dim: string, speed: number): MovieSettings | null {
  try {
    const rv = resolveView(manifest, element.view);
    // The board plays the whole dimension; on a slide the playback's range is the default when it plays this dimension.
    return resolveMovie(manifest, { view: element.view, crop: element.crop, width: element.width, height: element.height, playback: element.playback }, { dim, speed: speed > 0 ? speed : 1 }, hasDecorationView(manifest, rv));
  } catch { return null; }
}

export { movieFacts };

/** Write the movie of the live element along `dim` (the rail's key). Resolves when the job ends. */
export async function startImageMovie(element: FluximgElement, name: string, settings: MovieSettings): Promise<void> {
  if (get(imageMovieJob)?.running) return;
  const bridge = fileBridge();
  if (!bridge?.exportImageMovie) throw new Error("Writing a movie needs the desktop app");
  const root = get(projectModel)?.root;
  if (!root) throw new Error("Open a project first");
  const id = crypto.randomUUID();
  const update = (change: Partial<ImageMovieJob>) => imageMovieJob.update((job) => (job?.id === id ? { ...job, ...change } : job));
  imageMovieJob.set({ id, elementId: element.id, dim: settings.dim, running: true, cancelling: false, progress: 0, frame: 0, total: 0 });
  const unsubscribe = bridge.onImageMovieProgress?.((p) => {
    if (p.jobId !== id || p.phase !== "encoding" || !(p.total > 0)) return;
    update({ progress: Math.min(1, p.frame / p.total), frame: p.frame, total: p.total });
  });
  try {
    // The movie is made from the saved project (by element id, as the verb makes it): what is on screen is saved first.
    settleLiveEdit();
    const onSlide = storeTenant() === "slide";
    let slide: string | undefined, beatId: string | undefined;
    if (onSlide) {
      exitEndpointEdit(); sealHistory();
      const deck = get(deckOverlay), sid = get(activeFigureId), dest = get(editDestination);
      if (!deck || !sid) throw new Error("The slide is not open");
      slide = `${deck.id}/${sid}`;
      if (dest.kind === "after") beatId = dest.beatId;
    }
    const flushed = await flushByIdChecked(onSlide ? "slide" : "figure");
    if (!flushed.ok || get(dirty)) throw new Error("Save the project successfully before writing a movie");
    if (get(imageMovieJob)?.cancelling) { update({ result: { ok: false, cancelled: true } }); return; }
    const result = await bridge.exportImageMovie({
      root, jobId: id, elementId: element.id, name, dim: settings.dim, from: settings.from, to: settings.to,
      ...(settings.speed !== 1 ? { speed: settings.speed } : {}), ...(slide ? { slide } : {}), ...(beatId ? { beatId } : {}),
    });
    update({ result, ...(result.ok ? { progress: 1 } : {}) });
  } catch (error) { update({ result: { ok: false, error: error instanceof Error ? error.message : String(error) } }); }
  finally { unsubscribe?.(); update({ running: false }); }
}

/** Press again: stop the movie being written (the partial file is removed by the writer). */
export async function cancelImageMovie(): Promise<void> {
  const job = get(imageMovieJob);
  if (!job?.running || job.cancelling) return;
  imageMovieJob.set({ ...job, cancelling: true });
  await fileBridge()?.cancelImageMovie?.(job.id);
}
