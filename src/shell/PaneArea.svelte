<script lang="ts">
  import Pane from "./Pane.svelte";
  import { panes, focusedPaneId } from "./paneStore";

  let host: HTMLDivElement;
  let ratio = $state(0.5); // left pane share when split
  let dragging = $state(false);

  function startDrag(e: PointerEvent) {
    dragging = true;
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
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
  }
</script>

<div class="panearea" bind:this={host} class:dragging>
  {#each $panes as pane, i (pane.id)}
    {#if i > 0}
      <div
        class="divider"
        role="separator"
        aria-orientation="vertical"
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
  .divider:hover .grip {
    background: var(--c-accent);
    box-shadow: 0 0 8px var(--c-accent-glow);
    width: 2px;
  }
</style>
