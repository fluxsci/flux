<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { FluxPlotManifest } from "./types";
  import ColormapPicker from "../ColormapPicker.svelte";
  import { findColormap, colormapGradient } from "../color/collections";
  export let assetId = "";
  export let manifest: FluxPlotManifest | undefined;
  export let params: Record<string, unknown> = {};
  export let busy = false;
  const dispatch = createEventDispatcher<{ regenerate: Record<string, unknown> }>();
  type Draft = { key: string; label: string; cmap: string; min: number | undefined; max: number | undefined; log: boolean; rangeEditable: boolean };
  let drafts: Draft[] = [];
  let error = "";
  /** The draft whose colormap picker is open (2026-09-16: every fluxplot map, by collection). */
  let picking: string | null = null;
  const preview = (name: string) => { const f = findColormap(name); return f ? colormapGradient(f.map, f.reversed) : ""; };
  let seededAsset = "";
  let seededManifest: FluxPlotManifest | undefined;
  $: if (manifest !== seededManifest || assetId !== seededAsset) {
    seededManifest = manifest; seededAsset=assetId; picking=null;
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
    <form on:submit|preventDefault={apply} on:input={() => (error="")}>
      {#each drafts as draft (draft.key)}
        <fieldset disabled={busy}>
          <legend>{draft.label}</legend>
          <label>Palette
            <span class="cmapctl">
              <button type="button" class="cmapbtn" title="Browse every colormap fluxplot ships" aria-label={`${draft.label} colormap`} on:click={() => (picking = picking === draft.key ? null : draft.key)}>
                <span class="cmapbar" style={`background:${preview(draft.cmap) || "transparent"}`}></span>
              </button>
              <input on:keydown|stopPropagation bind:value={draft.cmap} spellcheck="false" aria-label={`${draft.label} palette`} />
            </span>
          </label>
          {#if picking === draft.key}
            <div class="cmappick">
              <ColormapPicker mode="map" value={draft.cmap} onPick={(name) => { draft.cmap = name; drafts = drafts; picking = null; }} onCancel={() => (picking = null)} />
            </div>
          {/if}
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
  summary { cursor: var(--cursor-cross-hover); padding: 6px 0; }
  fieldset { border: 1px solid #555; display: grid; gap: 6px; margin: 6px 0; padding: 8px; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  input { width: 140px; color: inherit; background: #222; border: 1px solid #666; border-radius: 3px; padding: 4px; }
  .cmapctl { display: flex; align-items: center; gap: 6px; }
  .cmapctl input { width: 118px; }
  .cmapbtn { width: 56px; height: 22px; padding: 2px; background: #222; border: 1px solid #666; border-radius: 3px; }
  .cmapbar { display: block; width: 100%; height: 100%; border-radius: 2px; }
  .cmappick { margin: 2px 0 6px; padding: 6px; border: 1px solid #555; border-radius: 3px; }
  button { padding: 5px 8px; cursor: var(--cursor-cross-hover); }
  p { opacity: .8; }
  [role="alert"] { color: #f4a5a5; }
</style>
