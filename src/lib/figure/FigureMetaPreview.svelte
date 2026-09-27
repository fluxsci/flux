<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { mdInlineFragment } from '../../shell/modes/paper/science/mdInline';
  import { pointerDrag } from '../ui/pointerDrag';
  import Icon from '../../shell/Icon.svelte';

  export let figureId: string;
  export let title: string;
  export let image = '';
  export let error = '';
  export let caption = '';
  export let captionLabel = '';
  export let aspect = 1;
  let viewport: HTMLDivElement, sheet: HTMLDivElement;
  let width = 1, height = 1, sheetHeight = 1;
  let fit = true, manualScale = 1, previousFigure = '';
  let observer: ResizeObserver | undefined;
  let cancelPan: (() => void) | undefined;
  let panning = false;
  let alive = true;
  const sheetWidth = 640;
  $: fitScale = Math.max(.001, Math.min((width - 32) / sheetWidth, (height - 32) / sheetHeight));
  $: scale = fit ? fitScale : manualScale;
  $: stageWidth = Math.max(width, sheetWidth * scale + 32);
  $: stageHeight = Math.max(height, sheetHeight * scale + 32);
  $: percent = Math.round(scale * 100);
  $: if (figureId !== previousFigure) { previousFigure = figureId; fit = true; if (viewport) viewport.scrollTo(0, 0); }
  function measure() {
    if (!alive || !viewport || !sheet) return;
    width = viewport.clientWidth; height = viewport.clientHeight; sheetHeight = sheet.offsetHeight;
  }
  export function reconnect() {
    observer?.disconnect();
    if (!alive || !viewport || !sheet) return;
    const owner = viewport.ownerDocument.defaultView as Window & typeof globalThis;
    observer = new owner.ResizeObserver(measure);
    observer.observe(viewport); observer.observe(sheet); measure();
    void viewport.ownerDocument.fonts.ready.then(measure);
  }
  function watch(_node: HTMLElement) { void tick().then(reconnect); return { destroy() { observer?.disconnect(); } }; }
  function fitAll() { fit = true; viewport.scrollTo(0, 0); }
  async function zoom(next: number, x = width / 2, y = height / 2) {
    // Keep the point under the pointer still while changing the rendered scale.
    const old = scale;
    const px = (viewport.scrollLeft + x - (stageWidth - sheetWidth * old) / 2) / old;
    const py = (viewport.scrollTop + y - (stageHeight - sheetHeight * old) / 2) / old;
    manualScale = Math.max(.05, Math.min(8, next)); fit = false;
    await tick();
    if (!alive) return;
    viewport.scrollLeft = (stageWidth - sheetWidth * scale) / 2 + px * scale - x;
    viewport.scrollTop = (stageHeight - sheetHeight * scale) / 2 + py * scale - y;
  }
  function wheel(node: HTMLElement) {
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault(); e.stopPropagation();
      const box = node.getBoundingClientRect();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? height : 1);
      void zoom(scale * Math.exp(-Math.max(-250, Math.min(250, delta)) * .003), e.clientX - box.left, e.clientY - box.top);
    };
    node.addEventListener('wheel', handler, { passive:false });
    return { destroy() { node.removeEventListener('wheel', handler); } };
  }
  function pan(e: PointerEvent) {
    if (e.button !== 0 || fit) return;
    const x = viewport.scrollLeft, y = viewport.scrollTop, startX = e.clientX, startY = e.clientY;
    panning = true;
    cancelPan = pointerDrag(e, move => { viewport.scrollLeft = x - move.clientX + startX; viewport.scrollTop = y - move.clientY + startY; }, () => { viewport.scrollTo(x, y); panning = false; }, () => { panning = false; cancelPan = undefined; });
  }
  function keys(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '0') { e.preventDefault(); fitAll(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); void zoom(scale * 1.2); }
    else if (e.key === '-') { e.preventDefault(); void zoom(scale / 1.2); }
  }
  function inlineCaption(node: HTMLElement, text: string) {
    const update = (value: string) => node.replaceChildren(mdInlineFragment(value));
    update(text); return { update };
  }
  onDestroy(() => { alive = false; observer?.disconnect(); cancelPan?.(); });
</script>

<div class="preview-tools">
  <span class="preview-label"><Icon name="eye" size={13} /> Preview</span>
  <div class="zoom-controls">
    <button aria-label="Zoom out preview" title="Zoom out" on:click={() => zoom(scale / 1.25)}><Icon name="min" size={13} /></button>
    <select aria-label="Preview zoom" value={fit ? 'fit' : String(percent)} on:change={e => e.currentTarget.value === 'fit' ? fitAll() : zoom(Number(e.currentTarget.value) / 100)}>
      <option value="fit">Fit · {percent}%</option>
      {#if ![25,50,75,100,150,200,400].includes(percent)}<option value={percent}>{percent}%</option>{/if}
      {#each [25,50,75,100,150,200,400] as p}<option value={p}>{p}%</option>{/each}
    </select>
    <button aria-label="Zoom in preview" title="Zoom in" on:click={() => zoom(scale * 1.25)}><Icon name="plus" size={13} /></button>
    <button class:active={fit} aria-label="Fit figure and caption" title="Fit figure and caption (Ctrl+0)" on:click={fitAll}><Icon name="max" size={13} /></button>
  </div>
</div>
<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
<div class="preview-viewport" class:zoomed={!fit} class:panning bind:this={viewport} role="region" aria-label="Figure preview" tabindex="0" use:watch use:wheel on:pointerdown={pan} on:keydown={keys} data-scale={scale} data-fit={fit}>
  <div class="preview-stage" style={`width:${stageWidth}px;height:${stageHeight}px`}>
    <div class="preview-sheet" bind:this={sheet} style={`width:${sheetWidth}px;left:${(stageWidth-sheetWidth*scale)/2}px;top:${(stageHeight-sheetHeight*scale)/2}px;transform:scale(${scale})`}>
      <div class="art" style={`aspect-ratio:${aspect > 0 ? aspect : 1}`}>
        {#if image}<img src={image} alt={title} draggable="false" />{:else}<p>{error || 'Preparing preview…'}</p>{/if}
      </div>
      <div class="caption-preview"><strong>{captionLabel}</strong><span use:inlineCaption={caption || 'No caption yet.'}></span></div>
    </div>
  </div>
</div>
<div class="preview-tip">Ctrl + scroll to zoom <span>·</span> drag to pan <span>·</span> fit includes the caption</div>
<style>
  .preview-tools { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 14px; border-bottom:1px solid var(--c-line); }
  .preview-label { display:flex; align-items:center; gap:6px; font:10px var(--font-mono); text-transform:uppercase; letter-spacing:.06em; color:var(--c-tx-muted); }
  .zoom-controls { display:flex; gap:3px; align-items:center; }
  button, select { color:var(--c-tx-2); background:transparent; border:1px solid transparent; border-radius:var(--r-ui); font:10px var(--font-mono); height:25px; }
  button { display:grid; place-items:center; width:25px; padding:0; } select { width:87px; background:var(--c-bg); padding:0 4px; border-color:var(--c-line); }
  button:hover,button.active { color:var(--c-accent); background:var(--c-accent-tint); } button:focus-visible,select:focus-visible { outline:1px solid var(--c-accent); }
  .preview-viewport { min-height:0; flex:1; overflow:auto; outline:none; overscroll-behavior:contain; }
  .preview-viewport:focus-visible { box-shadow:inset 0 0 0 1px var(--c-accent); } .zoomed { cursor:grab; } .panning { cursor:grabbing; }
  .preview-stage { position:relative; } .preview-sheet { position:absolute; transform-origin:0 0; user-select:none; }
  .art { background:#fff; display:flex; align-items:center; justify-content:center; overflow:hidden; box-shadow:0 0 0 1px var(--c-line-strong); }
  .art img { display:block; width:100%; height:100%; object-fit:contain; pointer-events:none; }
  .art p { color:#575653; font:14px var(--font-ui); }
  .caption-preview { font:16px/1.6 var(--font-serif); padding:18px 0 2px; overflow-wrap:anywhere; white-space:pre-wrap; color:var(--c-tx); } .caption-preview strong { margin-inline-end:.3em; }
  .preview-tip { padding:8px 10px; text-align:center; font:9px var(--font-mono); color:var(--c-tx-muted); border-top:1px solid var(--c-line); } .preview-tip span { padding:0 4px; }
  @media(max-width:900px) { .preview-label { display:none; } .preview-tools { justify-content:center; } .preview-tip { font-size:8px; } }
</style>
