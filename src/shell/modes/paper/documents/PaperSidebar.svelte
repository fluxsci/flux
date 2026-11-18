<script lang="ts">
  import type { Snippet } from 'svelte';
  import { paperLayout } from '../view-mode/paperLayoutStore';
  let { files, outlineContent }: { files: Snippet; outlineContent: Snippet } = $props();
  let body: HTMLDivElement;
  let dragging = $state(false);
  let liveSplit = $state<number | null>(null);
  const split = $derived(liveSplit ?? $paperLayout.filesFraction);
  function toggle(which: 'files' | 'outline') {
    paperLayout.update(s => ({ ...s, sidebarView: s.sidebarView === 'both' ? (which === 'files' ? 'outline' : 'files') : s.sidebarView === which ? (which === 'files' ? 'outline' : 'files') : 'both' }));
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    const r = body.getBoundingClientRect();
    liveSplit = Math.max(.15, Math.min(.85, (e.clientY - r.top) / r.height));
  }
  function finish() {
    if (!dragging) return;
    if (liveSplit != null) paperLayout.update(s => ({ ...s, filesFraction: liveSplit! }));
    dragging = false; liveSplit = null;
  }
  function reset() { paperLayout.update(s => ({ ...s, filesFraction: .5 })); }
</script>
<svelte:window onpointermove={move} onpointerup={finish} onpointercancel={() => { dragging = false; liveSplit = null; }} onblur={finish} />
<div class="paper-sidebar" class:dragging>
  <div class="sidebar-toolbar" aria-label="Sidebar sections">
    <button aria-pressed={$paperLayout.sidebarView !== 'outline'} title={$paperLayout.sidebarView === 'outline' ? 'Show files' : 'Hide files'} onclick={() => toggle('files')}><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 4h4.5l1.5 1.6H14v7.9H2z" /></svg>Files</button>
    <button aria-pressed={$paperLayout.sidebarView !== 'files'} title={$paperLayout.sidebarView === 'files' ? 'Show outline' : 'Hide outline'} onclick={() => toggle('outline')}><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 4h11M5 8h8.5M7.5 12h6" /></svg>Outline</button>
  </div>
  <div class="sidebar-body" bind:this={body}>
    {#if $paperLayout.sidebarView !== 'outline'}
      <div class="files-section" style:flex={$paperLayout.sidebarView === 'both' ? `${split} 1 0px` : '1 1 0px'}>{@render files()}</div>
    {/if}
    {#if $paperLayout.sidebarView === 'both'}
      <!-- WAI-ARIA window splitter: a focusable separator is interactive. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div class="sidebar-divider" role="separator" tabindex="0" aria-label="Resize files and outline" aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(split * 100)}
        onpointerdown={(e) => { if (e.button === 0) { e.preventDefault(); dragging = true; } }} ondblclick={reset}
        onkeydown={(e) => {
          if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); reset(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); paperLayout.update(s => ({ ...s, filesFraction: Math.max(.15, Math.min(.85, s.filesFraction + (e.key === 'ArrowUp' ? -.05 : .05))) })); }
        }}></div>
    {/if}
    {#if $paperLayout.sidebarView !== 'files'}
      <div class="outline-section" style:flex={$paperLayout.sidebarView === 'both' ? `${1-split} 1 0px` : '1 1 0px'}>{@render outlineContent()}</div>
    {/if}
  </div>
</div>
<style>
  .paper-sidebar { height:100%; min-height:0; display:flex; flex-direction:column; background:var(--flx-paper); border:1.5px solid var(--c-edge); border-radius:var(--r-3); overflow:hidden; }
  /* Two switches, not two tabs: each shows or hides its half. On = ink with a rail under it. */
  .sidebar-toolbar { display:flex; border-bottom:1px solid var(--c-line-strong); }
  .sidebar-toolbar button { flex:1; display:flex; align-items:center; justify-content:center; gap:6px; height:calc(32px * var(--ts-scale, 1)); padding:0 6px; border:0; border-right:1px solid var(--c-line); font:600 var(--ts-xs) var(--font-serif); letter-spacing:.01em; color:var(--c-tx-faint); background:transparent; cursor: var(--cursor-cross-hover); transition: background 70ms linear, color 70ms linear, box-shadow 70ms linear; }
  .sidebar-toolbar button:last-child { border-right:0; }
  .sidebar-toolbar svg { flex:none; fill:none; stroke:currentColor; stroke-width:1.3; stroke-linecap:round; stroke-linejoin:round; }
  .sidebar-toolbar button:hover { background:var(--c-accent-tint-2); color:var(--c-tx); }
  .sidebar-toolbar button:active { background:var(--c-accent-tint); }
  .sidebar-toolbar button[aria-pressed='true'] { color:var(--c-tx-hi); box-shadow:inset 0 -2px 0 var(--c-accent); }
  .sidebar-toolbar button:focus-visible { outline:2px solid var(--c-accent); outline-offset:-2px; }
  .sidebar-body { flex:1; display:flex; flex-direction:column; min-height:0; }
  .files-section, .outline-section { min-height:0; overflow:hidden; }
  .outline-section { display:flex; }
  .outline-section :global(.outline) { height:100%; width:100%; border:0; border-radius:0; padding:12px; box-sizing:border-box; }
  /* The split: a hairline with a short grip, 7 px to grab; it lights up, it does not turn
     into a blue bar. */
  .sidebar-divider { position:relative; flex:0 0 7px; cursor:row-resize; background:transparent; touch-action:none; }
  .sidebar-divider::before { content:""; position:absolute; left:0; right:0; top:3px; height:1px; background:var(--c-line-strong); transition: background 80ms linear; }
  .sidebar-divider::after { content:""; position:absolute; left:50%; top:2px; width:26px; height:3px; margin-left:-13px; border-radius:2px; background:var(--c-line-strong); transition: background 80ms linear; }
  .sidebar-divider:hover::before, .sidebar-divider:focus-visible::before, .dragging .sidebar-divider::before,
  .sidebar-divider:hover::after, .sidebar-divider:focus-visible::after, .dragging .sidebar-divider::after { background:var(--c-accent); }
  .sidebar-divider:focus-visible { outline:0; }
  .dragging { user-select:none; cursor:row-resize; }
</style>
