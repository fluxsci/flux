<script lang="ts" context="module">
  // Which items have their agent's work opened, for as long as the app runs: moving to another
  // item and back must not fold it again. Folded is the default.
  const opened = new Set<string>();
</script>
<script lang="ts">
  // A background agent on this item. The THREAD is the conversation (what you wrote, what the
  // agent answered); this is the agent's WORK, and it stays out of the way: ONE line under the
  // thread says who is working, on what, for how long (with Stop), or, once it has stopped,
  // what it did in a few words. Everything it thought, read and ran is behind that line, for
  // whoever wants it. (Owner, 2026-11-19: "I get this black box below it, and i have no idea
  // what that black box is … no clutter please, only give extra/long context if the user wants
  // (expands) it!" It used to be an always-open dark panel listing every step.)
  // The steps are RENDERED only while open: a long run is hundreds of rows nobody asked for.
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
  let error = "", busy = false, open = false, openFor = "";
  $: if (item.id !== openFor) { openFor = item.id; open = opened.has(item.id); }
  $: run = $backgroundRuns.get(item.id);
  $: active = busy || !!run && ["starting", "running"].includes(run.state);
  $: driverName = run?.driver === "codex" ? "Codex" : "Claude Code";
  $: agentName = run?.name || driverName;
  $: phase = run ? (active ? (transcriptActivity(run.transcript) || run.reason || (run.state === "starting" ? `Starting ${driverName}…` : "Working…")) : friendly(run.state, run.reason)) : "";
  const friendly = (state: string, reason?: string) => state === "idle" ? "Ready for a reply" : state === "done" ? "Finished" : state === "failed" ? (reason || "Failed") : state === "cancelled" ? "Stopped" : state;
  // What it did, in a few words: how many steps (tool uses) and how long it worked.
  $: steps = run ? run.transcript.turns.reduce((n, t) => n + (t.role === "agent" ? t.blocks.reduce((m, b) => m + (b.kind === "tools" ? b.calls.length : 0), 0) : 0), 0) : 0;
  $: worked = run ? run.transcript.turns.reduce((ms, t) => ms + (t.role === "agent" && t.endedAt ? Math.max(0, t.endedAt - t.startedAt) : 0), 0) : 0;
  const span = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`; };
  $: did = [steps ? `${steps} step${steps === 1 ? "" : "s"}` : "", worked >= 1000 ? span(worked) : ""].filter(Boolean).join(" · ");
  $: hasWork = !!run && run.transcript.turns.length > 0;
  onMount(() => { initBackgroundRuns(); void refreshBackgroundCapabilities(); });
  function toggle() { if (!hasWork) return; open = !open; if (open) opened.add(item.id); else opened.delete(item.id); }
  function onLineKey(e: KeyboardEvent) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }
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
  {#if run}<div class="work" class:active class:open role="group" aria-label="Background activity" data-state={run.state}>
    <div class="line">
      <!-- The whole line opens the work (it holds a live status, so it is a row with a button's role, not a <button>). -->
      <div class="show" class:can={hasWork} role="button" tabindex={hasWork ? 0 : -1} aria-expanded={open} aria-disabled={!hasWork} title={hasWork ? (open ? "Hide the agent's work" : "Show the agent's work: what it thought, read and ran") : ""} on:click={toggle} on:keydown={onLineKey}>
        <span class="caret" aria-hidden="true"></span>
        <WorkingLine busy={active} {phase} agent={agentName} seed={run.name || run.driver} startedAt={run.startedAt} mark={run.state === "failed" ? "error" : run.state === "cancelled" ? "idle" : "done"} onstop={stop} showStop={false} />
        {#if !active && did}<span class="did mono">{did}</span>{/if}
      </div>
      {#if active}<button class="stop" on:click={stop}>Stop</button>{/if}
    </div>
    {#if run.error}<p class="error" role="alert">{run.error}</p>{/if}
    {#if open && hasWork}
      <div class="steps">
        <Transcript transcript={run.transcript} agent={driverName} seed={run.name || run.driver} dense showMeta={false} quietHuman />
        <div class="foot mono" title="How this run is known to the command line">{run.display || `bg · ${run.driver} · ${run.name ?? ""}`} · {run.state}{#if run.usage} · {fmtTokens(run.usage.inputTokens)} in → {fmtTokens(run.usage.outputTokens)} out{run.usage.costUsd !== undefined ? ` · $${run.usage.costUsd.toFixed(run.usage.costUsd < 0.1 ? 3 : 2)}` : ""}{/if}</div>
      </div>
    {/if}
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
  /* The agent's work: one line in the thread's own voice, no box. A hairline above sets it apart
     from the conversation; the rail at its left says what state the run is in. */
  .work { margin-top: 2px; padding: 8px 0 0 10px; border-top: 1px solid var(--c-line); box-shadow: inset 2px 0 0 var(--c-line-strong); }
  .work.active { box-shadow: inset 2px 0 0 var(--c-accent); }
  .work[data-state="failed"] { box-shadow: inset 2px 0 0 var(--c-danger); }
  .line { display: flex; align-items: center; gap: 8px; min-height: 26px; }
  .show { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; min-height: 26px; padding: 0 6px 0 2px; border-radius: var(--r-ui); outline: none; transition: background 80ms linear; }
  .show.can { cursor: var(--cursor-cross-hover); }
  .show.can:hover, .show.can:focus-visible { background: var(--c-ui-hover); }
  .show :global(.working-line) { flex: 1; min-width: 0; }
  .caret { flex: 0 0 auto; width: 8px; height: 8px; background: currentColor; color: var(--c-tx-muted); opacity: 0; transition: rotate 80ms linear;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; }
  .show.can .caret { opacity: .7; }
  .work.open .caret { rotate: 90deg; }
  .did { flex: 0 0 auto; color: var(--c-tx-faint); font-size: 10.5px; white-space: nowrap; }
  .stop { flex: 0 0 auto; height: 22px; padding: 0 8px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); }
  .stop:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  /* Opened: the steps, indented under the line, in a window of their own so a long run never
     pushes the reply box off the panel. */
  .steps { margin: 6px 0 2px 17px; padding: 2px 8px 2px 0; max-height: min(46vh, 420px); overflow: auto; scrollbar-width: thin; }
  .foot { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--c-line); color: var(--c-tx-faint); font-size: 10px; overflow-wrap: anywhere; }
  @media (prefers-reduced-motion: reduce) { .show, .caret { transition: none; } }
  .error { color: var(--c-danger); margin: 4px 0 0; overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
