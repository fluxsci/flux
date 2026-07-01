<script lang="ts">
  import { fade } from "svelte/transition";
  import { toasts, dismissToast } from "../lib/toast";
  import { DUR } from "../lib/motion/tokens";

  // `raised` lifts the stack clear of the shell's capture toast when both show.
  let { raised = false }: { raised?: boolean } = $props();
</script>

{#if $toasts.length}
  <div class="toasts" class:raised aria-label="Notifications">
    {#each $toasts as t (t.id)}
      <div
        class="toast"
        class:err={t.level === "error"}
        class:ok={t.level === "success"}
        role={t.level === "error" ? "alert" : "status"}
        transition:fade={{ duration: DUR.quick }}>
        <div class="t-body">
          <span class="t-msg">{t.msg}</span>
          {#if t.detail}<span class="t-detail" title={t.detail}>{t.detail}</span>{/if}
        </div>
        {#if t.action}
          <button
            class="t-act"
            onclick={() => {
              t.action?.run();
              dismissToast(t.id);
            }}>{t.action.label}</button>
        {/if}
        {#if t.ttl === 0}
          <button class="t-x" title="Dismiss" onclick={() => dismissToast(t.id)}>✕</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Mirrors the shell capture-toast pill (Shell.svelte) — one visual family. */
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    z-index: 210;
    display: flex;
    flex-direction: column-reverse;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .toasts.raised {
    bottom: 76px;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px 8px 18px;
    border-radius: var(--r-pill);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    font-size: var(--ts-sm);
    box-shadow: var(--elev-2);
    max-width: 70vw;
    pointer-events: auto;
  }
  .toast.ok {
    border-color: var(--c-success);
  }
  .toast.err {
    border-color: var(--c-danger);
  }
  .t-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .t-msg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t-detail {
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 52vw;
  }
  .t-act {
    border: 1px solid var(--c-accent);
    background: transparent;
    color: var(--c-accent-bright);
    border-radius: var(--r-pill);
    font-size: var(--ts-xs);
    padding: 3px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .t-act:hover {
    background: var(--c-accent-tint);
  }
  .t-x {
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 0 2px;
    line-height: 1;
  }
  .t-x:hover {
    color: var(--c-danger);
  }
</style>
