<script lang="ts">
  // A host for the SHARED persistent terminal session (terminalSession.ts) —
  // the same shell the Paper margin's Terminal view mounts. Used by the reader's
  // Ask-AI pane; mounting here detaches it there and vice versa (one session,
  // one screen, wherever you summon it).
  import { onDestroy, onMount } from "svelte";
  import { attach, detach, fitNow, isAvailable, termStatus } from "./terminalSession";

  let host = $state<HTMLDivElement | undefined>(undefined);
  let ro: ResizeObserver | null = null;

  onMount(() => {
    if (host && isAvailable()) {
      attach(host);
      ro = new ResizeObserver(() => fitNow());
      ro.observe(host);
    }
  });
  onDestroy(() => {
    ro?.disconnect();
    detach(host); // ownership-guarded: a stale detach can't yank the moved host
  });
</script>

{#if isAvailable()}
  <div class="tp-host" bind:this={host}></div>
{:else}
  <div class="tp-unavail">
    The terminal needs the Flux desktop app. Status: {$termStatus}.
  </div>
{/if}

<style>
  .tp-host {
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  .tp-unavail {
    display: grid;
    place-content: center;
    height: 100%;
    color: var(--c-tx-faint);
    font-size: var(--ts-sm, 13px);
  }
</style>
