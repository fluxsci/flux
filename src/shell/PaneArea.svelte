<script lang="ts">
  import { onDestroy } from "svelte";
  import Pane from "./Pane.svelte";
  import { panes, focusedPaneId } from "./paneStore";

  let host: HTMLDivElement;
  let ratio = $state(0.5); // left pane share when split
  let dragging = $state(false);
  let originalRatio = .5;

  function startDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    endDrag(); originalRatio = ratio;
    dragging = true;
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("blur", cancelDrag);
  }
  function onMove(e: PointerEvent) {
    if (!dragging || !host) return;
    const r = host.getBoundingClientRect();
    ratio = Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width));
  }
  function endDrag() {
    dragging = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", cancelDrag);
    window.removeEventListener("blur", cancelDrag);
  }
  function cancelDrag() { if (dragging) ratio = originalRatio; endDrag(); }
  function resizeKey(e: KeyboardEvent) {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    ratio = e.key === 'Home' ? .2 : e.key === 'End' ? .8 : Math.min(.8, Math.max(.2, ratio + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? .1 : .02)));
  }
  onDestroy(endDrag);
</script>

<div class="panearea" bind:this={host} class:dragging>
  {#each $panes as pane, i (pane.id)}
    {#if i > 0}
      <!-- ARIA window splitters are focusable separators; keyboard resize is tested. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Pane width"
        aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)}
        tabindex="0" onkeydown={resizeKey}
        onpointerdown={startDrag}>
        <span class="grip"></span>
      </div>
    {/if}
    <div class="slot" style="flex: {$panes.length === 1 ? 1 : i === 0 ? ratio : 1 - ratio} 1 0">
      <Pane {pane} focused={$focusedPaneId === pane.id} />
    </div>
  {/each}
</div>

<style>
  .panearea {
    display: flex;
    height: 100%;
    width: 100%;
  }
  .panearea.dragging {
    cursor: col-resize;
    user-select: none;
  }
  .slot {
    min-width: 0;
    height: 100%;
  }
  .divider {
    flex: 0 0 auto;
    width: 7px;
    display: grid;
    place-items: center;
    cursor: col-resize;
    background: var(--c-bg);
    position: relative;
  }
  .divider .grip {
    width: 1px;
    height: 100%;
    background: var(--c-line-strong);
    transition: background var(--dur-instant) var(--ease-standard);
  }
  .divider:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
  .divider:hover .grip {
    background: var(--c-accent);
    box-shadow: 0 0 8px var(--c-accent-glow);
    width: 2px;
  }
</style>
