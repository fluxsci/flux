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
    <button aria-pressed={$paperLayout.sidebarView !== 'outline'} title={$paperLayout.sidebarView === 'outline' ? 'Show files' : 'Hide files'} onclick={() => toggle('files')}>Files</button>
    <button aria-pressed={$paperLayout.sidebarView !== 'files'} title={$paperLayout.sidebarView === 'files' ? 'Show outline' : 'Hide outline'} onclick={() => toggle('outline')}>Outline</button>
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
  .paper-sidebar { height:100%; min-height:0; display:flex; flex-direction:column; background:var(--flx-paper); border:1px solid var(--c-edge); border-radius:var(--r-3); overflow:hidden; }
  .sidebar-toolbar { display:flex; gap:4px; padding:6px; border-bottom:1px solid var(--c-line); }
  .sidebar-toolbar button { flex:1; padding:5px; border:0; border-radius:var(--r-1); font:inherit; font-size:var(--ts-xs); color:var(--c-tx-faint); background:transparent; cursor:pointer; }
  .sidebar-toolbar button[aria-pressed='true'] { color:var(--c-tx-hi); background:var(--c-ui-hover); }
  .sidebar-body { flex:1; display:flex; flex-direction:column; min-height:0; }
  .files-section, .outline-section { min-height:0; overflow:hidden; }
  .outline-section { display:flex; }
  .outline-section :global(.outline) { height:100%; width:100%; border:0; border-radius:0; padding:12px; box-sizing:border-box; }
  .sidebar-divider { flex:0 0 7px; cursor:row-resize; background:var(--c-bg); border-block:1px solid var(--c-line); touch-action:none; }
  .sidebar-divider:hover, .sidebar-divider:focus-visible, .dragging .sidebar-divider { background:var(--c-accent); outline:0; }
  .dragging { user-select:none; cursor:row-resize; }
</style>
