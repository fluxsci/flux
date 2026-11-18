<script lang="ts">
  import { onMount } from "svelte";
  import { fileBridge, type RunnerCapability, type RunnerDriver } from "../../lib/project/types";
  let { heading = true }: { heading?: boolean } = $props();
  let caps = $state<RunnerCapability[]>([]), loaded = $state(false), error = $state("");
  let driver = $state<RunnerDriver | "">(""), model = $state(""), effort = $state("");
  let concurrency = $state(2);
  let saving: Promise<unknown> = Promise.resolve();
  const choices = $derived(caps.filter(c => c.detected));
  const selected = $derived(caps.find(c => c.driver === driver));
  const efforts = $derived(driver === "claude" ? ["low", "medium", "high", "max"] : ["minimal", "low", "medium", "high", "xhigh"]);
  onMount(() => {
    let gone = false;
    void (async () => {
      const fb = fileBridge();
      if (!fb?.runnerCapabilities) throw new Error("Agent launching is available in the desktop app");
      const [found, prefs] = await Promise.all([fb.runnerCapabilities(), fb.prefsGet?.()]);
      if (gone) return;
      caps = found;
      const p = prefs?.fluxchat as { driver?: RunnerDriver; model?: string; effort?: string; backgroundConcurrency?: number } | undefined;
      driver = p?.driver ?? found.find(c => c.available)?.driver ?? ""; model = p?.model ?? ""; effort = p?.effort ?? "";
      concurrency = p?.backgroundConcurrency ?? 2;
      loaded = true;
    })().catch(e => { if (!gone) { error = e.message; loaded = true; } });
    return () => { gone = true; };
  });
  function save() {
    if (!loaded || !driver) return;
    const fluxchat = { driver, model: model.trim(), effort, backgroundConcurrency: concurrency };
    saving = saving.catch(() => {}).then(async () => {
      await fileBridge()?.prefsSet?.({ fluxchat }); error = "";
    }).catch(e => { error = `Could not save agent settings: ${e.message}`; });
  }
</script>
<!-- The same row anatomy as the Settings dialog: the name on the left, the control at the right edge. -->
<section aria-label="Agent that Flux launches">
  {#if heading}<h3>Agent that Flux launches</h3>{/if}
  <p>Runs your installed CLI with your own login; usage counts against your plan.</p>
  {#if !loaded}<p role="status">Checking installed agents…</p>{/if}
  {#if loaded && !choices.length && !error}<p>Install and sign in to Claude Code or Codex in your terminal to use Ask.</p>{/if}
  <label><span>Agent</span> <select bind:value={driver} disabled={!choices.length} onchange={() => { model = ""; effort = ""; save(); }}>
    <option value="" disabled>Choose an installed agent</option>
    {#each choices as c}<option value={c.driver} disabled={!c.available}>{c.driver === "claude" ? "Claude Code" : "Codex"}{c.available ? "" : " (update required)"}</option>{/each}
  </select></label>
  <label><span>Model</span> <input bind:value={model} placeholder="CLI default" disabled={!selected?.available || !selected.model} onchange={save} /></label>
  <label><span>Effort</span> <select bind:value={effort} disabled={!selected?.available || !selected.effort} onchange={save}>
    <option value="">CLI default</option>{#each efforts as value}<option value={value}>{value}</option>{/each}
  </select></label>
  <label><span>Background runs</span> <select bind:value={concurrency} onchange={save}>{#each [1, 2, 3] as n}<option value={n}>{n} at a time</option>{/each}</select></label>
  {#each choices.filter(c => !c.available) as c}<p class="error">{c.reason}</p>{/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
<style>
  section { margin: 10px 0 2px; font: 13px/1.35 var(--font-serif); }
  h3 { margin: 0 0 2px; font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--c-tx-faint); }
  p { max-width: 68ch; margin: 2px 0 4px; color: var(--c-tx-muted); font: 11.5px/1.5 var(--font-serif); }
  label { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 20px; min-height: 32px; padding: 4px 0; color: var(--c-tx); }
  input, select { box-sizing: border-box; width: var(--ctl, 212px); min-width: 0; height: 24px; margin: 0; padding: 0 8px; color: var(--c-tx); background-color: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); font: 12px var(--font-ui); transition: border-color 80ms linear; }
  select { appearance: none; -webkit-appearance: none; padding-right: 24px; text-overflow: ellipsis; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23878580' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5l3-3'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; background-size: 11px 11px; cursor: var(--cursor-cross-hover); }
  input::placeholder { color: var(--c-tx-faint); }
  input:hover:not(:disabled), select:hover:not(:disabled) { border-color: var(--c-tx-muted); }
  input:focus, select:focus { outline: none; border-color: var(--c-accent); }
  input:disabled, select:disabled { opacity: .5; }
  .error { color: var(--c-danger); }
  @media (prefers-reduced-motion: reduce) { input, select { transition: none; } }
</style>
