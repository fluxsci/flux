<script lang="ts">
  import { onMount } from "svelte";
  import type { Slide, StageSize } from "../../../lib/slide/types";
  import { DEFAULT_VIDEO_OPTIONS, videoOptions, videoSize, planSlideVideo, type SlideVideoOptions } from "../../../lib/slide/video";
  let { slide, stage, durations, onExport, onClose }: { slide: Slide; stage: StageSize; durations: number[]; onExport: (options: SlideVideoOptions) => void; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  const saved = (() => { try { return videoOptions(JSON.parse(localStorage.getItem("flux.slide.videoOptions") || "{}")); } catch { return DEFAULT_VIDEO_OPTIONS; } })();
  let delay = $state(saved.stepDelayMs / 1000), start = $state(saved.startHoldMs / 1000), end = $state(saved.endHoldMs / 1000);
  let height = $state(saved.height), fps = $state(saved.fps);
  const settings = $derived.by(() => {
    try {
      if ([delay, start, end].some(value => value === undefined || value === null)) return null;
      const options = videoOptions({ stepDelayMs: delay * 1000, startHoldMs: start * 1000, endHoldMs: end * 1000, height, fps });
      return { options, size: videoSize(stage, height), plan: planSlideVideo(slide, durations, options) };
    } catch { return null; }
  });
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null, modal = dialog;
    modal.showModal(); modal.querySelector<HTMLInputElement>("input")?.focus();
    return () => { modal.close(); previous?.focus({ preventScroll: true }); };
  });
  function submit(event: SubmitEvent) {
    event.preventDefault(); if (!settings) return;
    try { localStorage.setItem("flux.slide.videoOptions", JSON.stringify(settings.options)); } catch { /* optional preference */ }
    onExport(settings.options);
  }
</script>

<dialog bind:this={dialog} aria-labelledby="video-export-title" oncancel={event => { event.preventDefault(); onClose(); }} onkeydown={event => event.stopPropagation()}>
  <form onsubmit={submit}>
    <h2 id="video-export-title">Export slide video</h2>
    <p class="subtitle">{slide.name || "Current slide"} · MP4</p>
    <div class="timing">
      <label>Delay between steps <span><input aria-label="Delay between steps" type="number" min="0" max="60" step="any" required bind:value={delay} /> seconds</span></label>
      <label>Hold at start <span><input aria-label="Hold at start" type="number" min="0" max="60" step="any" required bind:value={start} /> seconds</span></label>
      <label>Hold at end <span><input aria-label="Hold at end" type="number" min="0" max="60" step="any" required bind:value={end} /> seconds</span></label>
    </div>
    <p class="hint">The delay replaces manual clicks. Steps set to run together stay together; automatic steps keep their timing.</p>
    <div class="quality">
      <label>Resolution<select aria-label="Video resolution" bind:value={height}><option value={720}>720p</option><option value={1080}>1080p · Full HD</option><option value={2160}>2160p · 4K</option></select></label>
      <label>Frame rate<select aria-label="Video frame rate" bind:value={fps}><option value={60}>60 fps · Smoothest</option><option value={30}>30 fps</option></select></label>
    </div>
    <p class="estimate" aria-live="polite">{#if settings}{settings.size.width} × {settings.size.height} · approximately {(settings.plan.frameCount / fps).toFixed(1)} seconds{:else}Enter valid timing and resolution settings.{/if}</p>
    <footer><button type="button" onclick={onClose}>Cancel</button><button type="submit" class="primary" disabled={!settings}>Export MP4…</button></footer>
  </form>
</dialog>

<style>
  dialog{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);margin:0;width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:24px;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line-strong);border-radius:12px;box-shadow:0 16px 64px #0006;font:13px var(--font-serif)}
  dialog::backdrop{background:#0006}h2{font-size:20px;margin:0 0 6px}.subtitle{color:var(--c-tx-2);margin:0 0 22px;overflow-wrap:anywhere}
  .timing{display:grid;gap:14px}.timing label{display:flex;justify-content:space-between;align-items:center;gap:12px}.timing span{color:var(--c-tx-2);white-space:nowrap}.timing input{width:72px;text-align:right;margin-right:5px}
  input,select,button{font:inherit;color:var(--c-tx);background:var(--c-bg-2);border:1px solid var(--c-line-strong);border-radius:5px;padding:7px}input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
  .hint{font-size:12px;line-height:1.5;color:var(--c-tx-2);margin:18px 0 22px}.quality{display:flex;gap:16px}.quality label{display:grid;gap:8px;flex:1;min-width:0}select{width:100%}.estimate{font-size:12px;color:var(--c-tx-2);margin:20px 0}footer{display:flex;justify-content:flex-end;gap:8px}button{padding:8px 13px;cursor:pointer}.primary{background:var(--c-accent);color:var(--c-bg);border-color:var(--c-accent);font-weight:600}button:disabled{opacity:.5;cursor:default}
</style>
