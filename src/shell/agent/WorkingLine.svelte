<script lang="ts">
  // The one status line every run shows: [seed] phase … elapsed [Stop].
  // The phase is whatever the newest event means ("Reading paper/draft.qmd…",
  // "Thinking…", "Writing…"); the elapsed counter appears after one second
  // (Nielsen: no feedback needed under 1 s) and ticks through a setTimeout
  // chain, never rAF. After ten seconds Stop gains the accent outline.
  import { onDestroy } from "svelte";
  import AgentMark from "./AgentMark.svelte";
  let { busy, phase = "", agent = "", seed = "", startedAt = 0, mark = "idle", onstop, showStop = true, size = 14 }:
    { busy: boolean; phase?: string; agent?: string; seed?: string; startedAt?: number; mark?: "idle" | "working" | "done" | "error"; onstop?: () => void; showStop?: boolean; size?: number } = $props();
  let elapsed = $state(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    timer = null;
    if (!busy || !startedAt) { elapsed = 0; return; }
    elapsed = Math.floor((Date.now() - startedAt) / 1000);
    timer = setTimeout(tick, 1000 - ((Date.now() - startedAt) % 1000));
  };
  $effect(() => {
    void busy; void startedAt;
    if (timer) clearTimeout(timer);
    elapsed = 0;
    if (busy && startedAt) timer = setTimeout(tick, 1000 - ((Date.now() - startedAt) % 1000));
    return () => { if (timer) clearTimeout(timer); timer = null; };
  });
  onDestroy(() => { if (timer) clearTimeout(timer); });
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const markState = $derived(busy ? "working" : mark);
</script>

<div class="working-line" class:busy role="status" aria-live="polite" data-elapsed={elapsed}>
  <AgentMark {size} state={markState} {seed} />
  {#if agent}<span class="agent">{agent}</span>{/if}
  {#key phase}<span class="phase arrive">{phase}</span>{/key}
  <span class="grow"></span>
  {#if busy && elapsed >= 1}<span class="elapsed mono">{clock(elapsed)}</span>{/if}
  {#if busy && showStop && onstop}<button class="stop" class:urgent={elapsed >= 10} onclick={onstop}>Stop</button>{/if}
</div>

<style>
  .working-line { display: flex; align-items: center; gap: 8px; min-height: 26px; font: var(--ts-xs) var(--font-ui); color: var(--c-tx-muted); }
  .agent { color: var(--c-tx-2); font-weight: 500; }
  .phase { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grow { flex: 1; }
  .elapsed { font-size: 10.5px; color: var(--c-tx-faint); font-variant-numeric: tabular-nums; }
  .stop { height: 22px; padding: 0 8px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); }
  .stop:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  .stop.urgent { border-color: var(--c-accent); color: var(--c-accent); }
</style>
