/** Window-owned job state survives editor mode changes. Work runs out of process. */
import { get, writable } from "svelte/store";
import { fileBridge } from "../project/types";
import type { SlideVideoOptions, SlideVideoProgress, SlideVideoResult } from "./video";
export interface VideoJob { id: string; root: string; name: string; running: boolean; cancelling: boolean; progress: SlideVideoProgress; result?: SlideVideoResult }
export const slideVideoJob = writable<VideoJob | null>(null);
export async function startSlideVideo(request: { root: string; deckId: string; slideId: string; name: string; options: SlideVideoOptions }, prepare: () => Promise<void>): Promise<void> {
  if (get(slideVideoJob)?.running) return;
  const bridge = fileBridge();
  if (!bridge?.exportSlideVideo) throw new Error("Video export is available in the desktop app");
  const id = crypto.randomUUID();
  const update = (change: Partial<VideoJob>) => slideVideoJob.update(job => job?.id === id ? { ...job, ...change } : job);
  slideVideoJob.set({ id, root: request.root, name: request.name, running: true, cancelling: false, progress: { jobId: id, phase: "preparing", frame: 0, total: 0 } });
  const unsubscribe = bridge.onSlideVideoProgress?.(progress => { if (progress.jobId === id) update({ progress }); });
  try {
    await prepare();
    if (get(slideVideoJob)?.cancelling) { update({ result: { ok: false, cancelled: true } }); return; }
    const result = await bridge.exportSlideVideo({ root: request.root, deckId: request.deckId, slideId: request.slideId, options: request.options, jobId: id });
    update({ result });
  } catch (error) { update({ result: { ok: false, error: error instanceof Error ? error.message : String(error) } }); }
  finally { unsubscribe?.(); update({ running: false }); }
}
export async function cancelSlideVideo(): Promise<void> {
  const job = get(slideVideoJob);
  if (!job?.running || job.cancelling) return;
  slideVideoJob.set({ ...job, cancelling: true });
  await fileBridge()?.cancelSlideVideo?.(job.id);
}
