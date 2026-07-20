<script lang="ts">
  // The project-wide Agent drawer (Ctrl+Shift+J / palette): the user's standing
  // principal-agent session in a real terminal, docked at the bottom of the
  // workspace. The session itself is the module-scoped principalSession
  // singleton — this component only attaches/detaches the live xterm host, so
  // toggling the drawer or switching modes never kills the conversation.
  import { onDestroy, onMount } from "svelte";
  import {
    attach,
    detach,
    fitNow,
    initPrincipalSession,
    isAvailable,
    principalInfo,
    principalNotice,
    principalStatus,
    restart,
  } from "./principalSession";
  import { principalDrawerOpen } from "../command/commandBus";
  import { copyPrincipalPrompt } from "../command/globalCommands";

  let host = $state<HTMLDivElement | undefined>(undefined);
  let ro: ResizeObserver | null = null;

  // Drag-resizable height, persisted. Default = the old fixed 42%.
  const HEIGHT_KEY = "flux.principalDrawer.heightPx";
  const MIN_H = 160;
  let heightPx = $state<number | null>(null);
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    if (saved >= MIN_H) heightPx = saved;
  } catch {
    /* no persistence — default height */
  }
  let dragging = false;
  let dragStartY = 0;
  let dragStartH = 0;
  let pdEl = $state<HTMLDivElement | undefined>(undefined);

  function maxH(): number {
    const parent = pdEl?.parentElement?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_H, Math.floor(parent * 0.85));
  }
  function onGutterDown(e: PointerEvent) {
    // No preventDefault here — it would suppress the derived dblclick (reset).
    dragging = true;
    dragStartY = e.clientY;
    dragStartH = pdEl?.clientHeight ?? 300;
    document.body.style.userSelect = "none";
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture keeps real drags alive off-element; its failure must not kill the drag */
    }
  }
  function onGutterMove(e: PointerEvent) {
    if (!dragging) return;
    heightPx = Math.min(maxH(), Math.max(MIN_H, dragStartH + (dragStartY - e.clientY)));
  }
  function onGutterUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    try {
      if (heightPx !== null) localStorage.setItem(HEIGHT_KEY, String(Math.round(heightPx)));
    } catch {
      /* non-persistent env */
    }
  }
  function onGutterReset() {
    heightPx = null; // back to the 42% default
    try {
      localStorage.removeItem(HEIGHT_KEY);
    } catch {
      /* ignore */
    }
  }

  onMount(() => {
    initPrincipalSession();
    if (host) {
      attach(host);
      ro = new ResizeObserver(() => fitNow());
      ro.observe(host);
    }
  });
  onDestroy(() => {
    ro?.disconnect();
    detach();
  });

  function close() {
    principalDrawerOpen.set(false);
  }
</script>

<div
  class="pd"
  role="region"
  aria-label="Agent drawer"
  bind:this={pdEl}
  style={heightPx !== null ? `flex-basis:${heightPx}px` : ""}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="pd-gutter"
    title="Drag to resize · double-click to reset"
    onpointerdown={onGutterDown}
    onpointermove={onGutterMove}
    onpointerup={onGutterUp}
    onpointercancel={onGutterUp}
    ondblclick={onGutterReset}>
  </div>
  <div class="pd-bar">
    <span class="pd-title">Principal</span>
    {#if $principalInfo}
      <span class="pd-meta">{$principalInfo.command} · {$principalInfo.cwd}</span>
    {:else if $principalStatus === "connecting"}
      <span class="pd-meta">starting…</span>
    {:else if $principalStatus === "unavailable"}
      <span class="pd-meta">needs the Flux desktop app</span>
    {/if}
    {#if $principalNotice}
      <span class="pd-warn" title={$principalNotice}>⚠ roster</span>
    {/if}
    <div class="pd-btns">
      <button
        class="pd-btn"
        disabled={!isAvailable()}
        onclick={() => void copyPrincipalPrompt()}
        title="Copy the boot prompt — paste it into your own terminal session instead (note: no transcript capture there)">
        Copy prompt
      </button>
      {#if $principalStatus === "exited"}
        <button class="pd-btn" onclick={() => void restart()}>Restart</button>
      {/if}
      <button class="pd-btn" onclick={close} title="Ctrl+Shift+J">Close</button>
    </div>
  </div>
  {#if isAvailable()}
    <div class="pd-term" bind:this={host}></div>
  {:else}
    <div class="pd-unavail">
      The Agent drawer needs the Flux desktop app (a real PTY). In the browser dev
      shell, run your principal in an external terminal instead — the project files
      are the same either way.
    </div>
  {/if}
</div>

<style>
  .pd {
    flex: 0 0 var(--pd-height, 42%);
    min-height: 160px;
    display: flex;
    flex-direction: column;
    border-top: 1.5px solid var(--c-line-strong, var(--c-edge));
    background: var(--c-bg);
    position: relative;
  }
  /* The resize gutter rides the drawer's top edge (outside the terminal's
     scroll area) — a slim hit zone that widens the border visually on hover. */
  .pd-gutter {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 9px;
    cursor: ns-resize;
    z-index: 5;
  }
  .pd-gutter:hover {
    background: color-mix(in oklab, var(--c-accent) 30%, transparent);
  }
  .pd-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-3, 10px);
    padding: 4px 10px;
    border-bottom: 1px solid var(--c-line, var(--c-edge));
    background: var(--c-surface);
  }
  .pd-title {
    font-size: var(--ts-xs, 11px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
  }
  .pd-meta {
    font-size: var(--ts-xs, 11px);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .pd-warn {
    font-size: var(--ts-xs, 11px);
    color: var(--c-warning);
  }
  .pd-btns {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }
  .pd-btn {
    font: inherit;
    font-size: var(--ts-xs, 11px);
    background: none;
    border: 1px solid var(--c-edge);
    border-radius: var(--r-1, 4px);
    color: var(--c-tx-2);
    padding: 2px 8px;
    cursor: pointer;
  }
  .pd-btn:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
  }
  .pd-term {
    flex: 1 1 auto;
    min-height: 0;
    padding: 4px 6px 6px;
  }
  .pd-unavail {
    flex: 1 1 auto;
    display: grid;
    place-content: center;
    padding: 20px;
    color: var(--c-tx-faint);
    font-size: var(--ts-sm, 13px);
    max-width: 60ch;
    margin: 0 auto;
    text-align: center;
  }
</style>
