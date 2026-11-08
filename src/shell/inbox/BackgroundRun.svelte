<script lang="ts">
  // A background agent on this item: the launch control and, once running, the
  // live card — the agent's name and state, what it is doing right now, Stop,
  // then everything it said and did through the shared Transcript. The raw
  // state word stays in the strip (the CLI and gates read it) beside the
  // friendly one.
  import { onMount } from "svelte";
  import type { InboxItem } from "../../lib/project/inbox";
  import type { RunnerDriver } from "../../lib/project/types";
  import { currentProject } from "../shellStore";
  import { backgroundDrivers, backgroundRuns } from "./backgroundState";
  import { initBackgroundRuns, refreshBackgroundCapabilities, startBackgroundRun, stopBackgroundRun } from "./backgroundStore";
  import { transcriptActivity } from "../../lib/agent/transcript";
  import WorkingLine from "../agent/WorkingLine.svelte";
  import Transcript from "../agent/Transcript.svelte";
  export let item: InboxItem;
  let error = "", busy = false;
  $: run = $backgroundRuns.get(item.id);
  $: active = busy || !!run && ["starting", "running"].includes(run.state);
  $: driverName = run?.driver === "codex" ? "Codex" : "Claude Code";
  $: agentName = run?.name || driverName;
  $: phase = run ? (active ? (transcriptActivity(run.transcript) || run.reason || (run.state === "starting" ? `Starting ${driverName}…` : "Working…")) : friendly(run.state, run.reason)) : "";
  const friendly = (state: string, reason?: string) => state === "idle" ? "Ready for a reply" : state === "done" ? "Finished" : state === "failed" ? (reason || "Failed") : state === "cancelled" ? "Stopped" : state;
  onMount(() => { initBackgroundRuns(); void refreshBackgroundCapabilities(); });
  async function start(driver: RunnerDriver) {
    const root = $currentProject?.path;
    if (!root) return;
    busy = true; error = "";
    try { await startBackgroundRun(root, item.id, driver); } catch (e) { error = (e as Error).message; } finally { busy = false; }
  }
  async function stop() { if (run) try { await stopBackgroundRun(run.runId); } catch (e) { error = (e as Error).message; } }
  const fmtTokens = (n?: number) => n === undefined ? "?" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
</script>
<div class="background-run agent-surface" data-background-item={item.id} data-run-state={run?.state ?? ""}>
  {#if !["resolved", "withdrawn"].includes(item.status) && !run}
    <details class="launch"><summary tabindex="0"><span class="play" aria-hidden="true"></span>Run in background ▾</summary><div class="choices">
      {#each ["claude", "codex"] as driver}<button disabled={active || !$backgroundDrivers.includes(driver === "claude" ? "claude" : "codex")} on:click={() => start(driver === "claude" ? "claude" : "codex")}>{driver === "claude" ? "Claude Code" : "Codex"}</button>{/each}
      {#if !$backgroundDrivers.length}<small>Install and sign in to Claude Code or Codex, then check AI status.</small>{:else}<small>Starts your own installed agent on this item, with this project.</small>{/if}
    </div></details>
  {/if}
  {#if run}<div class="activity" class:active role="status" aria-label="Background activity" data-state={run.state}>
    <div class="strip">
      <WorkingLine busy={active} {phase} agent={agentName} seed={run.name || run.driver} startedAt={run.startedAt} mark={run.state === "failed" ? "error" : run.state === "cancelled" ? "idle" : "done"} onstop={stop} showStop={false} />
      <span class="display faint mono" title={run.display}>{run.display || `bg · ${run.driver} · ${run.name ?? ""}`}</span>
      <span class="state faint mono">{run.state}</span>
      {#if active}<button class="stop" on:click={stop}>Stop</button>{/if}
    </div>
    {#if run.transcript.turns.length}<div class="feed"><Transcript transcript={run.transcript} agent={driverName} seed={run.name || run.driver} dense showMeta={false} /></div>{/if}
    {#if run.usage}<div class="usage faint mono">{fmtTokens(run.usage.inputTokens)} in → {fmtTokens(run.usage.outputTokens)} out{run.usage.costUsd !== undefined ? ` · $${run.usage.costUsd.toFixed(run.usage.costUsd < 0.1 ? 3 : 2)}` : ""}</div>{/if}
    {#if run.error}<p class="error" role="alert">{run.error}</p>{/if}
  </div>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .background-run { font: var(--ts-xs) var(--font-ui); }
  .launch { margin: 0; }
  .launch summary { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); list-style: none; }
  .launch summary::-webkit-details-marker { display: none; }
  .launch summary:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  .play { width: 9px; height: 9px; background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7 4v16l13-8z'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7 4v16l13-8z'/%3E%3C/svg%3E") center / contain no-repeat; }
  .choices { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 0 2px; }
  .choices button { height: 24px; padding: 0 9px; border: 1px solid var(--c-line); background: var(--c-bg); color: var(--c-tx); border-radius: var(--r-ui); font: inherit; }
  .choices button:hover:not(:disabled) { background: var(--c-ui-hover); } .choices button:disabled { opacity: .45; }
  .choices small { flex-basis: 100%; color: var(--c-tx-muted); }
  .activity { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--c-line); border-left: 2px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); }
  .activity.active { border-left-color: var(--c-accent); }
  .activity[data-state="failed"] { border-left-color: var(--c-danger); }
  .strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .strip :global(.working-line) { flex: 1; min-width: 160px; }
  .display { font-size: 10px; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { font-size: 10px; }
  .stop { height: 22px; padding: 0 8px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); }
  .stop:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  .feed { padding-top: 2px; }
  .usage { font-size: 10px; }
  .error { color: var(--c-danger); margin: 4px 0 0; overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .faint { color: var(--c-tx-faint); }
</style>
