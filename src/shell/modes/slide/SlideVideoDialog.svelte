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
    <header><h2 id="video-export-title">Export slide video</h2><p class="subtitle">{slide.name || "Current slide"} · MP4</p></header>
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
  dialog {
    position: fixed; inset: 50% auto auto 50%; transform: translate(-50%, -50%); margin: 0;
    width: 440px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto; padding: 0;
    background: var(--c-surface); color: var(--c-tx); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel); box-shadow: var(--elev-2);
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased;
  }
  dialog::backdrop { background: rgba(0, 0, 0, .35); }
  form { display: flex; flex-direction: column; }
  /* ONE compact header line: title + muted context, hairline below */
  header { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; border-bottom: 1px solid var(--c-line); }
  h2 { margin: 0; font: 600 12px var(--font-ui); color: var(--c-tx); white-space: nowrap; }
  .subtitle { margin: 0; color: var(--c-tx-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .timing { display: grid; gap: 2px; padding: 8px 12px 0; }
  .timing label { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 24px; color: var(--c-tx-muted); }
  .timing span { color: var(--c-tx-2); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
  .timing input { width: 64px; text-align: right; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; }
  input, select, button {
    font: 12px var(--font-ui); color: var(--c-tx); background: var(--c-bg);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); height: 24px; padding: 2px 6px;
  }
  input:focus, select:focus { border-color: var(--c-accent); outline: none; }
  button:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
  .hint { font-size: 11px; line-height: 1.5; color: var(--c-tx-muted); margin: 0; padding: 8px 12px; }
  .quality { display: flex; gap: 12px; padding: 0 12px; }
  .quality label { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; color: var(--c-tx-muted); }
  select { width: 100%; }
  .estimate { font: 11px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); margin: 0; padding: 10px 12px; }
  footer { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--c-line); }
  button { background: transparent; color: var(--c-tx-2); padding: 3px 10px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  /* Export is the dialog's one primary */
  .primary { background: var(--c-accent); color: var(--c-on-accent); border-color: var(--c-accent); font-weight: 600; }
  .primary:hover:not(:disabled) { background: var(--c-accent-bright); border-color: var(--c-accent-bright); color: var(--c-on-accent); }
  button:disabled { opacity: .4; cursor: default; }
</style>
