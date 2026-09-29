<script lang="ts">
  import { onMount } from "svelte";
  import type { InboxItem } from "../../lib/project/inbox";
  import type { RunnerDriver } from "../../lib/project/types";
  import { currentProject } from "../shellStore";
  import { backgroundDrivers, backgroundRuns } from "./backgroundState";
  import { initBackgroundRuns, refreshBackgroundCapabilities, startBackgroundRun, stopBackgroundRun } from "./backgroundStore";
  export let item: InboxItem;
  let error = "", busy = false;
  $: run = $backgroundRuns.get(item.id);
  $: active = busy || !!run && ["starting", "running"].includes(run.state);
  onMount(() => { initBackgroundRuns(); void refreshBackgroundCapabilities(); });
  async function start(driver: RunnerDriver) {
    const root = $currentProject?.path;
    if (!root) return;
    busy = true; error = "";
    try { await startBackgroundRun(root, item.id, driver); } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  async function stop() { if (run) try { await stopBackgroundRun(run.runId); } catch (e) { error = (e as Error).message; } }
</script>
<div class="background-run" data-background-item={item.id}>
  {#if !["resolved", "withdrawn"].includes(item.status)}
    <details class="launch"><summary tabindex="0">Run in background ▾</summary><div class="choices">
      {#each ["claude", "codex"] as driver}<button disabled={active || !$backgroundDrivers.includes(driver === "claude" ? "claude" : "codex")} on:click={() => start(driver === "claude" ? "claude" : "codex")}>{driver === "claude" ? "Claude Code" : "Codex"}</button>{/each}
      {#if !$backgroundDrivers.length}<small>Install and sign in to Claude Code or Codex, then check AI status.</small>{/if}
    </div></details>
  {/if}
  {#if run}<div class="activity" role="status" aria-label="Background activity">
    <span>{run.display || (run.driver === "claude" ? "Claude Code" : "Codex")} · {run.state === "idle" ? "Ready for a reply" : run.state}</span>
    {#if active}<button on:click={stop}>Stop</button>{/if}
    {#if run.reason}<small>{run.reason}</small>{/if}
    {#each run.tools as tool (tool.toolId)}<details><summary tabindex="0">{tool.title} · {tool.status}</summary><pre>{typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}</pre></details>{/each}
    {#if run.usage}<small>{run.usage.inputTokens ?? "?"} input · {run.usage.outputTokens ?? "?"} output tokens{run.usage.costUsd !== undefined ? ` · $${run.usage.costUsd.toFixed(4)}` : ""}</small>{/if}
    {#if run.error}<p class="error" role="alert">{run.error}</p>{/if}
  </div>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .background-run { padding: 8px 16px; border-bottom: 1px solid var(--c-line); font: var(--ts-xs) var(--font-ui); max-height: 240px; overflow: auto; }
  summary { padding: 4px 0; cursor: var(--cursor-cross-hover); }
  .choices, .activity { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  button { border: 1px solid var(--c-line); background: var(--c-bg); color: var(--c-tx); border-radius: var(--r-ui); padding: 4px 7px; font: inherit; }
  button:disabled { opacity: .45; } small, .activity details { flex-basis: 100%; } small { color: var(--c-tx-muted); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto; }
  .error { color: var(--c-danger); }
</style>
