<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { FluxPlotManifest } from "./types";
  export let manifest: FluxPlotManifest | undefined;
  export let params: Record<string, unknown> = {};
  export let busy = false;
  const dispatch = createEventDispatcher<{ regenerate: Record<string, unknown> }>();
  type Draft = { key: string; label: string; cmap: string; min: number | undefined; max: number | undefined; log: boolean; rangeEditable: boolean };
  let drafts: Draft[] = [];
  let error = "";
  $: {
    const unique = new Map<string, Draft>();
    for (const series of manifest?.series ?? []) {
      const field = series.field;
      if (!field?.controlKey) continue;
      unique.set(field.controlKey, { key: field.controlKey,
        label: [series.panelId?.replace(/^panel\./, ""), series.name ?? series.id].filter(Boolean).join(" / "),
        cmap: field.cmap, min: field.normalization.vmin ?? undefined,
        max: field.normalization.vmax ?? undefined, log: field.normalization.kind === "LogNorm",
        rangeEditable: ["Normalize", "LogNorm", "SymLogNorm", "PowerNorm", "TwoSlopeNorm"].includes(field.normalization.kind) });
    }
    drafts = [...unique.values()];
    error = "";
  }
  function apply() {
    error = "";
    const colors = { ...((params.__fluxplot__ ?? {}) as Record<string, unknown>) };
    for (const draft of drafts) {
      const { min, max } = draft;
      if (!draft.cmap.trim() || (min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max)) ||
          (min != null && max != null && min >= max) || (draft.log && ((min != null && min <= 0) || (max != null && max <= 0)))) {
        error = "Choose a palette and a valid range (minimum below maximum; log ranges must be positive).";
        return;
      }
      colors[draft.key] = { cmap: draft.cmap.trim(), vmin: min ?? null, vmax: max ?? null };
    }
    dispatch("regenerate", { ...params, __fluxplot__: colors });
  }
</script>

{#if drafts.length}
  <details class="color-scales">
    <summary>Color scales</summary>
    <form on:submit|preventDefault={apply}>
      {#each drafts as draft (draft.key)}
        <fieldset disabled={busy}>
          <legend>{draft.label}</legend>
          <label>Palette <input on:keydown|stopPropagation bind:value={draft.cmap} spellcheck="false" aria-label={`${draft.label} palette`} /></label>
          <label>Minimum <input on:keydown|stopPropagation type="number" disabled={!draft.rangeEditable} step="any" bind:value={draft.min} placeholder="Auto" aria-label={`${draft.label} minimum`} /></label>
          <label>Maximum <input on:keydown|stopPropagation type="number" disabled={!draft.rangeEditable} step="any" bind:value={draft.max} placeholder="Auto" aria-label={`${draft.label} maximum`} /></label>
        </fieldset>
      {/each}
      <p>Regenerates the plot and colorbar from the source data.</p>
      {#if error}<p role="alert">{error}</p>{/if}
      <button type="submit" disabled={busy}>{busy ? "Regenerating…" : "Apply and regenerate"}</button>
    </form>
  </details>
{/if}

<style>
  .color-scales { margin: 6px 12px; font-size: 12px; }
  summary { cursor: pointer; padding: 6px 0; }
  fieldset { border: 1px solid #555; display: grid; gap: 6px; margin: 6px 0; padding: 8px; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  input { width: 140px; color: inherit; background: #222; border: 1px solid #666; border-radius: 3px; padding: 4px; }
  button { padding: 5px 8px; cursor: pointer; }
  p { opacity: .8; }
  [role="alert"] { color: #f4a5a5; }
</style>
