<script lang="ts">
  import { onMount } from "svelte";
  import { fileBridge, type RunnerCapability, type RunnerDriver } from "../../lib/project/types";
  let { heading = true }: { heading?: boolean } = $props();
  let caps = $state<RunnerCapability[]>([]), loaded = $state(false), error = $state("");
  let driver = $state<RunnerDriver | "">(""), model = $state(""), effort = $state("");
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
      const p = prefs?.fluxchat as { driver?: RunnerDriver; model?: string; effort?: string } | undefined;
      driver = p?.driver ?? found.find(c => c.available)?.driver ?? ""; model = p?.model ?? ""; effort = p?.effort ?? "";
      loaded = true;
    })().catch(e => { if (!gone) { error = e.message; loaded = true; } });
    return () => { gone = true; };
  });
  function save() {
    if (!loaded || !driver) return;
    const fluxchat = { driver, model: model.trim(), effort };
    saving = saving.catch(() => {}).then(async () => {
      await fileBridge()?.prefsSet?.({ fluxchat }); error = "";
    }).catch(e => { error = `Could not save agent settings: ${e.message}`; });
  }
</script>
<section aria-label="Agent that Flux launches">
  {#if heading}<h3>Agent that Flux launches</h3>{/if}
  <p>Runs your installed CLI with your own login; usage counts against your plan.</p>
  {#if !loaded}<p role="status">Checking installed agents…</p>{/if}
  {#if loaded && !choices.length && !error}<p>Install and sign in to Claude Code or Codex in your terminal to use Ask.</p>{/if}
  <label>Agent <select bind:value={driver} disabled={!choices.length} onchange={() => { model = ""; effort = ""; save(); }}>
    <option value="" disabled>Choose an installed agent</option>
    {#each choices as c}<option value={c.driver} disabled={!c.available}>{c.driver === "claude" ? "Claude Code" : "Codex"}{c.available ? "" : " (update required)"}</option>{/each}
  </select></label>
  <label>Model <input bind:value={model} placeholder="CLI default" disabled={!selected?.available || !selected.model} onchange={save} /></label>
  <label>Effort <select bind:value={effort} disabled={!selected?.available || !selected.effort} onchange={save}>
    <option value="">CLI default</option>{#each efforts as value}<option value={value}>{value}</option>{/each}
  </select></label>
  {#each choices.filter(c => !c.available) as c}<p class="error">{c.reason}</p>{/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
<style>
  section { margin: 18px 0; font: var(--ts-sm) var(--font-ui); }
  h3 { font-size: var(--ts-sm); margin-bottom: 7px; }
  p { color: var(--c-tx-muted); font-size: var(--ts-xs); line-height: 1.5; }
  label { display: flex; align-items: center; gap: 12px; margin: 7px 0; }
  input, select { margin-left: auto; width: 220px; height: 26px; box-sizing: border-box; color: var(--c-tx); background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-ui); padding: 2px 5px; font: inherit; }
  .error { color: var(--c-danger); }
</style>
