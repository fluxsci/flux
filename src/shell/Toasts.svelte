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
        class:wide={!!t.detail}
        role={t.level === "error" ? "alert" : "status"}
        data-toast-tag={t.tag}
        transition:fade={{ duration: DUR.quick }}>
        <span class="t-mark" aria-hidden="true">
          {#if t.level === "success"}
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
          {:else if t.level === "error"}
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3.2v6M8 12.2v.6" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 7v5.4M8 3.6v.6" /></svg>
          {/if}
        </span>
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
        {#each t.actions ?? [] as a (a.label)}
          <button
            class="t-act"
            onclick={() => {
              a.run();
              dismissToast(t.id);
            }}>{a.label}</button>
        {/each}
        {#if t.progress !== undefined}<span class="t-bar" aria-hidden="true"><span style={`width:${Math.round(Math.max(0, Math.min(1, t.progress)) * 1000) / 10}%`}></span></span>{/if}
        {#if t.ttl === 0}
          <button class="t-x" title="Dismiss" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
            <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* The app's notices: one line when that is all there is, a small card when a notice
     carries its reason. A mark says which kind before a word is read (done, wrong, FYI), the
     reason of a failure wraps instead of being cut at one line, and the buttons are buttons. */
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
    --tone: var(--c-accent);
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: 36px;
    max-width: min(70vw, 620px);
    padding: 7px 8px 7px 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: 9px;
    background: var(--c-surface);
    box-shadow:
      inset 2px 0 0 var(--tone),
      var(--elev-2);
    color: var(--c-tx);
    font: var(--ts-sm) var(--font-ui);
    pointer-events: auto;
  }
  /* A long job's bar: a hairline along the foot, in the toast's tone. It moves only when the job reports. */
  .toast:has(.t-bar) {
    position: relative;
  }
  .t-bar {
    position: absolute;
    left: 9px;
    right: 9px;
    bottom: 3px;
    height: 2px;
    border-radius: 1px;
    background: color-mix(in oklab, var(--tone) 16%, transparent);
    overflow: hidden;
  }
  .t-bar > span {
    display: block;
    height: 100%;
    background: var(--tone);
  }
  .toast.ok {
    --tone: var(--c-success);
  }
  .toast.err {
    --tone: var(--c-danger);
  }
  .toast.wide {
    align-items: flex-start;
    padding-top: 9px;
    padding-bottom: 9px;
  }
  .t-mark {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: color-mix(in oklab, var(--tone) 18%, transparent);
    color: var(--tone);
  }
  .t-mark svg,
  .t-x svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .t-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding-right: 4px;
  }
  .t-msg {
    color: var(--c-tx-hi);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toast.wide .t-msg {
    font-weight: 600;
    white-space: normal;
  }
  /* The reason: up to four lines, the whole text on hover. */
  .t-detail {
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    line-height: 1.45;
    white-space: pre-line;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .t-act {
    flex: 0 0 auto;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx);
    font: 600 var(--ts-xs) var(--font-ui);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear;
  }
  .t-act:hover {
    background: color-mix(in oklab, var(--tone) 14%, transparent);
    border-color: color-mix(in oklab, var(--tone) 60%, var(--c-line-strong));
  }
  .t-x {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-faint);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      color 80ms linear;
  }
  .t-x svg {
    stroke-width: 1.4;
  }
  .t-x:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .t-act:focus-visible,
  .t-x:focus-visible {
    outline: 2px solid var(--tone);
    outline-offset: 1px;
  }
</style>
