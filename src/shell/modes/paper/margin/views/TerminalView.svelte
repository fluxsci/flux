<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Icon from "../../../../Icon.svelte";
  import {
    attach,
    detach,
    fitNow,
    restart,
    isAvailable,
    termStatus,
    termInfo,
  } from "../../../../terminal/terminalSession";

  // The pane frame provides the chrome, so this is content-only: a slim
  // context bar plus the xterm mount. The shell itself is owned by
  // terminalSession (module scope) so it survives pane close/reopen; the
  // ResizeObserver refits it whenever the pane stack re-splits the height.
  let mountEl = $state<HTMLDivElement | undefined>(undefined);
  let ro: ResizeObserver | undefined;
  const available = isAvailable();

  onMount(() => {
    if (!available || !mountEl) return;
    attach(mountEl);
    // Reflow on margin resize / window resize.
    ro = new ResizeObserver(() => fitNow());
    ro.observe(mountEl);
  });

  onDestroy(() => {
    ro?.disconnect();
    detach(); // keep the shell + scrollback alive across view switches
  });

  // Compact path: keep the last two segments so the bar never overflows.
  function shortCwd(p: string): string {
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
  }
</script>

{#if !available}
  <div class="term-empty">
    <Icon name="terminal" size={24} />
    <p class="lead">The terminal runs in the Flux desktop app.</p>
    <span class="sub">Open Flux (not the browser dev server) to use a native shell here.</span>
  </div>
{:else}
  <div class="term">
    <div class="term-bar">
      <span class="loc" title={$termInfo?.cwd}>
        {#if $termInfo}
          {shortCwd($termInfo.cwd)}
        {:else if $termStatus === "connecting"}
          starting…
        {:else if $termStatus === "exited"}
          shell exited
        {:else}
          terminal
        {/if}
      </span>
      <button class="restart" title="Restart shell" onclick={() => restart()}>Restart</button>
    </div>
    <div class="term-mount" bind:this={mountEl}></div>
  </div>
{/if}

<style>
  .term {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--c-bg);
  }
  .term-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 4px var(--sp-2) 4px var(--sp-3);
    border-bottom: 1px solid var(--c-line);
  }
  .loc {
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
    color: var(--c-tx-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .restart {
    flex: 0 0 auto;
    font: inherit;
    font-size: var(--ts-xs);
    padding: 3px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
  }
  .restart:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
  }
  .term-mount {
    flex: 1 1 auto;
    min-height: 0;
    padding: 6px 4px 4px 8px;
    background: var(--c-bg);
    overflow: hidden;
  }

  .term-empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    padding: var(--sp-5);
    text-align: center;
    color: var(--c-tx-muted);
  }
  .term-empty .lead {
    margin: var(--sp-2) 0 0;
    color: var(--c-tx-2);
    font-size: var(--ts-base);
  }
  .term-empty .sub {
    font-size: var(--ts-sm);
    max-width: 32ch;
  }
</style>
