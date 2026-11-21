<script lang="ts">
  // The colour-scale editor (colour-system plan A7.5): one block per manifest colorScales[]
  // entry — colormap (every fluxplot map, or its table), reverse, norm kind, limits, centre /
  // gamma / symlog parameters, extend — edited LIVE through ops.setPlotColorScale (the same
  // one-undo edit-session UX as AxisView), "Apply to source" writes the complete v2
  // `__fluxplot__` control and regenerates, then clears the live override; "Reset" restores the
  // generated scale. Mounted in the Inspector, the property menu and the X-ray. Old manifests
  // without colorScales fall back to their series.field controls (regenerate only).
  import { onDestroy } from "svelte";
  import { project, mutate } from "../store";
  import { plotManifests, plotRecipes } from "./store";
  import { setPlotColorScale } from "../ops";
  import { editSession } from "../interact/editSession";
  import { colorScalePatch, controlFromView, describeScale, normKindsFor, pickScale, type ColorScaleFields } from "./colorScaleControls";
  import { plotColorScaleIssues } from "./colorScaleDom";
  import { effectiveScale } from "./colorscale";
  import { colormapLut, ensureColormapLuts } from "../color/colormapLuts";
  import { regeneratePlot } from "./regenerate";
  import ColormapPicker from "../ColormapPicker.svelte";
  import NumberField from "../NumberField.svelte";
  import type { FluxPlotColorScale } from "./types";

  export let elementId: string;
  /** The property menu's armed row: opened, no summary. */
  export let compact = false;
  /** "wide": the host gave this editor its whole body (the property menu's
   *  colour-scale view) — controls on the left, the palette list always open
   *  on the right. "stack": one column, the palette list opens inline. */
  export let layout: "stack" | "wide" = "stack";
  /** Wide layout: Escape inside the always-open palette list leaves the editor. */
  export let onClose: (() => void) | undefined = undefined;
  // the disclosure state is the user's (bound, not re-applied on every model update — Svelte 5
  // would close the block under a typing user and drop focus)
  let opened = compact;
  const session = editSession();
  onDestroy(session.finish);

  $: el = $project.figures.flatMap((f) => f.elements).find((e) => e.id === elementId);
  $: plot = el?.type === "plot" ? el : undefined;
  $: manifest = plot ? $plotManifests[plot.assetId] : undefined;
  $: scales = manifest?.colorScales ?? [];
  $: legacyKeys = scales.length ? [] : [...new Set((manifest?.series ?? []).map((s) => s.field?.controlKey).filter((k): k is string => !!k))];
  $: recipe = plot ? ($plotRecipes[plot.assetId] as { params?: Record<string, unknown> } | undefined) : undefined;
  $: hasRecipe = !!plot?.source?.recipePath;
  $: issues = plotColorScaleIssues(manifest, plot?.colorScale, colormapLut);
  $: effective = Object.fromEntries(scales.map((s) => [s.id, effectiveScale(s, plot?.colorScale?.[s.id], colormapLut)]));
  let error = "";
  let busy = false;
  let status = "";
  let picking: string | null = null;
  // Wide layout: the scale the permanent palette list edits (its chip was the
  // last one clicked; the first scale until then).
  $: target = layout === "wide" ? (scales.find((s) => s.id === picking) ?? scales[0] ?? null) : null;
  // legacy (pre-0.3.1) drafts: regenerate-only
  let legacy: Record<string, { cmap: string; min: number | null; max: number | null }> = {};
  // A draft belongs to one plot's generated values. The hosts reuse this instance as the selection
  // changes, so another element or a regenerated source reseeds the drafts and drops their error
  // (else plot A's unsent range would be applied to plot B); an unrelated store update keeps them.
  let draftSeed = "";
  $: {
    const seed = JSON.stringify([elementId, legacyKeys.map((key) => {
      const field = manifest?.series.find((s) => s.field?.controlKey === key)?.field;
      return [key, field?.cmap, field?.normalization.vmin, field?.normalization.vmax];
    })]);
    if (seed !== draftSeed) { draftSeed = seed; legacy = {}; error = ""; }
  }
  $: for (const key of legacyKeys) if (!legacy[key]) {
    const field = manifest?.series.find((s) => s.field?.controlKey === key)?.field;
    legacy[key] = { cmap: field?.cmap ?? "", min: field?.normalization.vmin ?? null, max: field?.normalization.vmax ?? null };
  }

  const LIMIT_KEYS: ("vmin" | "vmax")[] = ["vmin", "vmax"];
  const view = (id: string) => plot?.colorScale?.[id];
  const cmapName = (s: FluxPlotColorScale) => {
    const c = view(s.id)?.cmap;
    return typeof c === "string" ? c : c?.name ?? s.colormap.name;
  };
  function gradientOf(s: FluxPlotColorScale): string {
    const lut = effective[s.id]?.colormap.lut ?? s.colormap.lut;
    const n = Math.min(32, lut.length);
    const stops = Array.from({ length: n }, (_, i) => `${lut[Math.round((i * (lut.length - 1)) / Math.max(1, n - 1))].slice(0, 7)} ${((i / Math.max(1, n - 1)) * 100).toFixed(1)}%`);
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }
  const stepFor = (lo: number | null | undefined, hi: number | null | undefined) => {
    const span = lo != null && hi != null ? Math.abs(hi - lo) : 0;
    return span > 0 && Number.isFinite(span) ? 10 ** Math.floor(Math.log10(span) - 2) : 1;
  };

  function apply(scaleId: string, fields: ColorScaleFields) {
    if (!plot || !manifest) return;
    error = "";
    try {
      const scale = pickScale(manifest, scaleId);
      const patch = colorScalePatch(scale, view(scaleId), fields, colormapLut);
      mutate((p) => setPlotColorScale(p, elementId, scaleId, patch, scale));
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  function choose(scaleId: string, fields: ColorScaleFields) { session.run(() => apply(scaleId, fields)); session.finish(); }
  async function pickMap(scaleId: string, name: string) {
    await ensureColormapLuts();
    choose(scaleId, { cmap: name });
    if (layout !== "wide") picking = null;
  }
  function typedMap(scaleId: string, value: string) {
    const name = value.trim();
    if (!name) { choose(scaleId, { cmap: null }); return; }
    void ensureColormapLuts().then(() => choose(scaleId, { cmap: name }));
  }
  async function applyToSource() {
    // an invalid draft is showing: refuse rather than regenerate the last valid state behind it
    if (!plot || !manifest || busy || error) return;
    if (!scales.length) { applyLegacy(); return; }
    busy = true; status = "Regenerating…";
    try {
      await ensureColormapLuts();
      const controls = { ...((recipe?.params?.__fluxplot__ as Record<string, unknown> | undefined) ?? {}) };
      for (const scale of scales) controls[scale.id] = controlFromView(scale, view(scale.id), colormapLut);
      const out = await regeneratePlot(plot, { ...(recipe?.params ?? {}), __fluxplot__: controls });
      if (out.ok) {
        // the source now paints what the live view showed: the override has nothing to add
        const id = elementId, ids = scales.map((s) => s.id);
        mutate((p) => { for (const s of ids) setPlotColorScale(p, id, s, null); });
      } else if (out.message) error = out.message;
      status = out.message;
    } catch (e) { error = e instanceof Error ? e.message : String(e); status = ""; }
    finally { busy = false; }
  }
  async function applyLegacy() {
    if (!plot) return;
    const colors = { ...((recipe?.params?.__fluxplot__ as Record<string, unknown> | undefined) ?? {}) };
    for (const [key, d] of Object.entries(legacy)) {
      const log = manifest?.series.find((s) => s.field?.controlKey === key)?.field?.normalization.kind === "LogNorm";
      if (!d.cmap.trim() || (d.min != null && d.max != null && d.min >= d.max) || (log && ((d.min != null && d.min <= 0) || (d.max != null && d.max <= 0)))) {
        error = "Choose a palette and a valid range (minimum below maximum; log ranges must be positive)."; return;
      }
      colors[key] = { cmap: d.cmap.trim(), vmin: d.min, vmax: d.max };
    }
    busy = true; status = "Regenerating…";
    try {
      const out = await regeneratePlot(plot, { ...(recipe?.params ?? {}), __fluxplot__: colors });
      status = out.message; if (!out.ok && out.message) error = out.message;
    } finally { busy = false; }
  }
</script>

{#if plot && (scales.length || legacyKeys.length)}
  <details class="color-scales" class:compact class:wide={layout === "wide" && !!target} bind:open={opened}>
    <summary>Colour scales</summary>
    <form on:submit|preventDefault={applyToSource}>
      <div class="controls">
      {#each scales as scale (scale.id)}
        {@const v = view(scale.id)}
        {@const eff = effective[scale.id]}
        {@const kind = eff?.norm.kind ?? scale.norm.kind}
        {@const kinds = normKindsFor(scale)}
        <fieldset disabled={busy} data-color-scale-block={scale.id}>
          <legend>{describeScale(scale)}{#if scale.recolor !== "live"} · raster{/if}</legend>
          <label>Palette
            <span class="cmapctl">
              <button type="button" class="cmapbtn" title="Browse every colormap fluxplot ships" aria-label={`${scale.id} colormap`} disabled={!scale.editable?.cmap}
                class:target={target?.id === scale.id && scales.length > 1}
                on:click={() => (picking = layout === "wide" ? scale.id : picking === scale.id ? null : scale.id)}>
                <span class="cmapbar" style={`background:${gradientOf(scale)}`}></span>
              </button>
              <input on:keydown|stopPropagation value={cmapName(scale)} spellcheck="false" aria-label={`${scale.id} palette`} disabled={!scale.editable?.cmap}
                on:change={(e) => typedMap(scale.id, e.currentTarget.value)} />
            </span>
          </label>
          {#if picking === scale.id && layout !== "wide"}
            <div class="cmappick">
              <ColormapPicker mode="map" value={cmapName(scale)} onPick={(name) => void pickMap(scale.id, name)} onCancel={() => (picking = null)} />
            </div>
          {/if}
          <label class="inline">Reverse <input type="checkbox" aria-label={`${scale.id} reversed`} checked={!!v?.reversed} on:change={(e) => choose(scale.id, { reversed: e.currentTarget.checked })} /></label>
          {#if kinds.length > 1}
            <label>Norm <select aria-label={`${scale.id} norm`} value={kind} on:change={(e) => choose(scale.id, { norm: e.currentTarget.value === scale.norm.kind ? null : e.currentTarget.value as ColorScaleFields["norm"] })}>
              {#each kinds as k}<option value={k}>{k}</option>{/each}
            </select></label>
          {/if}
          {#if scale.editable?.limits}
            <div class="limits" data-color-scale-limits={scale.id}>
              {#each LIMIT_KEYS as key}
                <NumberField label={key === "vmin" ? "min" : "max"} title={`${scale.id} ${key} (data units)`}
                  value={v?.norm?.[key] ?? scale.norm[key] ?? 0} empty={v?.norm?.[key] == null}
                  placeholder={scale.norm[key] != null ? String(scale.norm[key]) : ""} step={stepFor(scale.norm.vmin, scale.norm.vmax)} live optional
                  on:preview={(e) => apply(scale.id, { [key]: e.detail ?? null })}
                  on:scrub={(e) => apply(scale.id, { [key]: e.detail })} />
              {/each}
              {#if kind === "twoslope" || kind === "centered"}
                <NumberField label="centre" title={`${scale.id} centre`} value={v?.norm?.vcenter ?? eff?.norm.vcenter ?? 0} empty={v?.norm?.vcenter == null}
                  placeholder={String(eff?.norm.vcenter ?? 0)} step={stepFor(scale.norm.vmin, scale.norm.vmax)} live optional
                  on:preview={(e) => apply(scale.id, { vcenter: e.detail ?? null })} on:scrub={(e) => apply(scale.id, { vcenter: e.detail })} />
              {/if}
              {#if kind === "power"}
                <NumberField label="gamma" title={`${scale.id} gamma`} value={v?.norm?.gamma ?? eff?.norm.gamma ?? 1} empty={v?.norm?.gamma == null}
                  placeholder={String(eff?.norm.gamma ?? 1)} step={0.05} min={0.01} live optional
                  on:preview={(e) => apply(scale.id, { gamma: e.detail ?? null })} on:scrub={(e) => apply(scale.id, { gamma: e.detail })} />
              {/if}
              {#if kind === "symlog"}
                <NumberField label="linthresh" title={`${scale.id} linear threshold`} value={v?.norm?.linthresh ?? eff?.norm.linthresh ?? 1} empty={v?.norm?.linthresh == null}
                  placeholder={String(eff?.norm.linthresh ?? 1)} step={0.1} min={1e-9} live optional
                  on:preview={(e) => apply(scale.id, { linthresh: e.detail ?? null })} on:scrub={(e) => apply(scale.id, { linthresh: e.detail })} />
                <NumberField label="linscale" title={`${scale.id} linear scale`} value={v?.norm?.linscale ?? eff?.norm.linscale ?? 1} empty={v?.norm?.linscale == null}
                  placeholder={String(eff?.norm.linscale ?? 1)} step={0.1} min={1e-9} live optional
                  on:preview={(e) => apply(scale.id, { linscale: e.detail ?? null })} on:scrub={(e) => apply(scale.id, { linscale: e.detail })} />
              {/if}
            </div>
          {/if}
          <label>Extend <select aria-label={`${scale.id} extend`} value={eff?.norm.extend ?? scale.norm.extend}
            on:change={(e) => choose(scale.id, { extend: e.currentTarget.value === scale.norm.extend ? null : e.currentTarget.value as ColorScaleFields["extend"] })}>
            {#each ["neither", "min", "max", "both"] as x}<option value={x}>{x}</option>{/each}
          </select></label>
          <button type="button" class="reset" disabled={!v} on:click={() => choose(scale.id, { reset: true })}>Reset</button>
          {#if scale.alpha}
            <p class="alpha" data-color-scale-alpha={scale.id} title="A second, opacity channel fluxplot recorded (alpha_by): each element's fill-opacity follows its own value. Edit it in the source (alpha_by, alpha_range, alpha_norm).">
              Opacity by {scale.alpha.source}: {scale.alpha.range[0]}–{scale.alpha.range[1]}{scale.alpha.norm.kind === "log" ? ", log" : ""}{scale.alpha.norm.vmin != null ? ` over ${scale.alpha.norm.vmin}…${scale.alpha.norm.vmax}` : ""} (source-only)
            </p>
          {/if}
        </fieldset>
      {/each}
      {#each legacyKeys as key (key)}
        <fieldset disabled={busy} data-color-scale-block={key}>
          <legend>{key}</legend>
          <label>Palette <input on:keydown|stopPropagation bind:value={legacy[key].cmap} spellcheck="false" aria-label={`${key} palette`} /></label>
          <label>Minimum <input on:keydown|stopPropagation type="number" step="any" bind:value={legacy[key].min} placeholder="Auto" aria-label={`${key} minimum`} /></label>
          <label>Maximum <input on:keydown|stopPropagation type="number" step="any" bind:value={legacy[key].max} placeholder="Auto" aria-label={`${key} maximum`} /></label>
        </fieldset>
      {/each}
      </div>
      {#if target}
        <div class="palette-pane" data-color-scale-palette={target.id}>
          {#if scales.length > 1}<div class="pane-head">Palette · {describeScale(target)}</div>{/if}
          {#key target.id}
            <ColormapPicker mode="map" value={cmapName(target)} autofocus={false} onPick={(name) => void pickMap(target.id, name)} onCancel={() => onClose?.()} />
          {/key}
        </div>
      {/if}
      <div class="notes">
      {#if scales.length}
        <p>Edits show live. Apply to source rewrites the recipe's colour controls and regenerates the plot and its key from the data.</p>
      {:else}
        <p>This plot predates live colour scales: the palette and range regenerate from the source data.</p>
      {/if}
      {#if error}<p role="alert">{error}</p>{:else if issues.length}<p role="status">{issues.join(" ")}</p>{/if}
      <div class="actions">
        <button type="submit" class="apply-source" disabled={busy || !hasRecipe} title={hasRecipe ? "Write the colour controls into the recipe and regenerate" : "This plot has no recipe to regenerate"}>
          {busy ? "Regenerating…" : scales.length ? "Apply to source" : "Apply and regenerate"}
        </button>
        {#if status && !busy}<span class="status" role="status">{status}</span>{/if}
      </div>
      </div>
    </form>
  </details>
{/if}

<style>
  .color-scales { margin: 6px 12px; font: 11px var(--font-ui); color: var(--c-tx); }
  .color-scales.compact { margin: 0; }
  summary { cursor: var(--cursor-cross-hover); padding: 6px 0; font: 10px var(--font-mono); color: var(--c-tx-muted); }
  .compact summary { display: none; }
  fieldset { border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); display: grid; gap: 6px; margin: 6px 0; padding: 8px; }
  legend { font: 10px var(--font-mono); color: var(--c-tx-muted); padding: 0 4px; }
  /* Every row fits its column: nothing scrolls sideways or pokes past its
     highlight (owner inbox 2026-09-30). */
  form { min-width: 0; }
  .controls, .notes { min-width: 0; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-width: 0; }
  label.inline { justify-content: flex-start; gap: 6px; }
  input, select { color: inherit; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 3px 4px; font: 11px var(--font-mono); }
  input[type="checkbox"] { width: auto; }
  .cmapctl { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; justify-content: flex-end; max-width: 260px; }
  .cmapctl input { flex: 1 1 auto; width: 0; min-width: 60px; }
  .cmapbtn.target { border-color: var(--c-accent); }
  .cmapbtn { width: 56px; height: 22px; padding: 2px; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); }
  .cmapbar { display: block; width: 100%; height: 100%; border-radius: 2px; }
  .cmappick { margin: 2px 0 6px; padding: 6px; border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); }
  .limits { display: flex; flex-wrap: wrap; align-items: end; gap: 5px; }
  button { padding: 4px 8px; cursor: var(--cursor-cross-hover); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx); font: 11px var(--font-mono); }
  button:disabled { opacity: .5; }
  .reset { justify-self: start; }
  .actions { display: flex; align-items: center; gap: 8px; }
  p { color: var(--c-tx-muted); margin: 4px 0; }
  [role="alert"] { color: #f4a5a5; }
  /* Wide: controls with their notes beneath | the always-open palette list. */
  .wide form { display: grid; grid-template-columns: minmax(240px, 0.85fr) minmax(300px, 1.15fr); grid-template-rows: auto 1fr; column-gap: 14px; align-items: start; }
  .wide .controls, .wide .notes { grid-column: 1; }
  .wide .palette-pane { grid-column: 2; grid-row: 1 / span 2; min-width: 0; margin-top: 6px; }
  .wide .palette-pane :global(.list) { max-height: min(52vh, 560px); }
  .pane-head { font: 10px var(--font-mono); color: var(--c-tx-muted); margin-bottom: 4px; }

  /* HOSTED in the property menu (its wide "colour scale" view) and in the X-ray (2026-11-20): the host's look,
     not a form set into it. A scale is a small eyebrow and one line per thing; a value is a well without a
     border; a choice wears the host's face; Reverse is an on/off key; the two actions are keys. The host's
     colours come in as a handful of properties declared HERE, on the block: it is a closed <details> in the
     X-ray until asked for (nothing under it is styled till then) and exists in the menu only in this view, so
     neither surface's ordinary open pays for them. The Inspector's look, above, is untouched. */
  :global(.fluxFigMenu) .color-scales {
    --h-well: var(--fm-well); --h-ring: rgba(255, 252, 240, 0.12); --h-ring-2: rgba(255, 252, 240, 0.26); --h-hi: var(--fm-blue); --h-tx: var(--fm-tx); --h-tx-hi: var(--fm-tx-hi); --h-dim: var(--fm-tx-dim);
    --h-key: var(--fm-paper); --h-key-ink: var(--fm-blue-deep); --h-key-edge: color-mix(in oklab, var(--fm-blue) 45%, transparent); --h-key-over: color-mix(in oklab, var(--fm-blue) 16%, var(--fm-paper));
    --h-on: var(--fm-blue); --h-on-ink: var(--fm-paper); --h-word: 12.5px var(--font-serif);
  }
  :global(.xray) .color-scales {
    --h-well: var(--xr-well); --h-ring: var(--xr-line); --h-ring-2: color-mix(in oklab, var(--xr-phos) 55%, transparent); --h-hi: var(--xr-phos-hi); --h-tx: var(--xr-tx); --h-tx-hi: var(--xr-hot); --h-dim: var(--xr-tx-dim);
    --h-key: color-mix(in oklab, var(--xr-phos) 13%, transparent); --h-key-ink: var(--xr-phos-hi); --h-key-edge: color-mix(in oklab, var(--xr-phos) 40%, transparent); --h-key-over: color-mix(in oklab, var(--xr-phos) 26%, transparent);
    --h-on: var(--xr-box); --h-on-ink: var(--xr-ink); --h-word: 12px var(--font-mono);
  }
  :global(:is(.fluxFigMenu, .xray)) .color-scales { margin: 0; color: var(--h-tx); font: var(--h-word); }
  :global(.xray) .color-scales { margin: 0 0 3px; border-bottom: 1px solid var(--xr-line); }
  :global(.xray) .color-scales:not([open]) { border-bottom-color: transparent; margin-bottom: 0; }
  :global(:is(.fluxFigMenu, .xray)) summary { height: 22px; padding: 0 9px; font: 600 9.5px/22px var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--h-dim); }
  :global(:is(.fluxFigMenu, .xray)) summary:hover { color: var(--h-tx-hi); }
  :global(.xray) form { padding: 0 9px 7px; }
  :global(:is(.fluxFigMenu, .xray)) fieldset { border: 0; border-radius: 0; margin: 0 0 4px; padding: 0; gap: 0; }
  :global(:is(.fluxFigMenu, .xray)) legend { height: 20px; padding: 0; font: 600 9.5px/20px var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--h-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  :global(:is(.fluxFigMenu, .xray)) label { min-height: 24px; gap: 8px; }
  /* Reverse is a row like the others: its name, and its key at the line's end. */
  :global(:is(.fluxFigMenu, .xray)) label.inline { justify-content: space-between; }
  :global(:is(.fluxFigMenu, .xray)) input, :global(:is(.fluxFigMenu, .xray)) select, :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf input) {
    box-sizing: content-box; height: 18px; padding: 0 5px; background: var(--h-well); border: 0; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--h-ring);
    color: var(--h-tx-hi); font: 11.5px/18px var(--font-mono); font-variant-numeric: tabular-nums; outline: none;
  }
  :global(:is(.fluxFigMenu, .xray)) input:hover, :global(:is(.fluxFigMenu, .xray)) select:hover, :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf input:hover) { box-shadow: inset 0 0 0 1px var(--h-ring-2); }
  :global(:is(.fluxFigMenu, .xray)) input:focus, :global(:is(.fluxFigMenu, .xray)) select:focus, :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf input:focus) { box-shadow: inset 0 0 0 1px var(--h-hi); }
  :global(:is(.fluxFigMenu, .xray)) input::placeholder, :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf input::placeholder) { color: var(--h-dim); font-style: italic; }
  /* A choice: no system arrow, a small drawn one (two gradients: nothing to fetch or decode). */
  :global(:is(.fluxFigMenu, .xray)) select {
    appearance: none; padding: 0 18px 0 6px; cursor: var(--cursor-cross-hover);
    background-image: linear-gradient(45deg, transparent 50%, var(--h-dim) 50%), linear-gradient(135deg, var(--h-dim) 50%, transparent 50%);
    background-position: calc(100% - 10px) 7px, calc(100% - 6px) 7px; background-size: 4px 4px; background-repeat: no-repeat;
  }
  :global(:is(.fluxFigMenu, .xray)) option { background: var(--h-well); color: var(--h-tx-hi); }
  /* An on/off key: the checkbox itself, drawn as the host's key. It says what it is, and is lit when on. */
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"] {
    appearance: none; display: inline-grid; place-items: center; box-sizing: border-box; width: 30px; height: 18px; margin: 0; padding: 0; border-radius: 5px;
    background: var(--h-key); border: 1px solid var(--h-key-edge); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); cursor: var(--cursor-cross-hover);
  }
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"]::after { content: "off"; font: 600 9.5px/1 var(--font-mono); color: var(--h-key-ink); }
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"]:hover { background: var(--h-key-over); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); }
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"]:checked { background: var(--h-on); border-color: var(--h-on); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); }
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"]:checked::after { content: "on"; color: var(--h-on-ink); }
  :global(:is(.fluxFigMenu, .xray)) input[type="checkbox"]:focus-visible { outline: 1.5px solid var(--h-hi); outline-offset: 1px; }
  /* The palette: its strip as a chip (the menu's colour chip), its name beside it. */
  :global(:is(.fluxFigMenu, .xray)) .cmapctl { gap: 8px; max-width: 230px; }
  :global(:is(.fluxFigMenu, .xray)) .cmapbtn { flex: none; width: 46px; height: 14px; padding: 0; border: 0; border-radius: 4px; background: none; overflow: hidden; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2px var(--h-ring-2); }
  :global(:is(.fluxFigMenu, .xray)) .cmapbtn:hover:not(:disabled), :global(:is(.fluxFigMenu, .xray)) .cmapbtn.target { background: none; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px var(--h-hi); }
  :global(:is(.fluxFigMenu, .xray)) .cmapbar { border-radius: 0; }
  /* The limits share a line, each a name and its number (the menu's pairs: x beside width). */
  :global(:is(.fluxFigMenu, .xray)) .limits { gap: 2px 16px; align-items: center; min-height: 24px; }
  :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf) { flex: 1 1 34%; flex-direction: row; align-items: center; justify-content: space-between; gap: 6px; min-height: 24px; }
  :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf .lb) { font: var(--h-word); letter-spacing: 0; color: var(--h-tx); }
  :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf .lb:hover) { color: var(--h-tx-hi); }
  :global(:is(.fluxFigMenu, .xray)) .limits :global(.nf input) { width: 8ch; text-align: right; }
  /* Keys: the host's (paper in the menu, glass in the X-ray). Reset is the quiet one. */
  :global(:is(.fluxFigMenu, .xray)) button:not(.cmapbtn) {
    height: 20px; padding: 0 8px; border-radius: 5px; background: var(--h-key); color: var(--h-key-ink); border: 1px solid var(--h-key-edge); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5);
    font: 600 10.5px/1 var(--font-mono); cursor: var(--cursor-cross-hover);
  }
  :global(:is(.fluxFigMenu, .xray)) button:not(.cmapbtn):hover:not(:disabled) { background: var(--h-key-over); border-color: var(--h-hi); }
  :global(:is(.fluxFigMenu, .xray)) button:not(.cmapbtn):active:not(:disabled) { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); }
  :global(:is(.fluxFigMenu, .xray)) button:focus-visible { outline: 1.5px solid var(--h-hi); outline-offset: 1px; }
  :global(:is(.fluxFigMenu, .xray)) button:disabled { opacity: 0.38; box-shadow: none; cursor: var(--cursor-cross); }
  :global(:is(.fluxFigMenu, .xray)) button.reset:not(.cmapbtn) { justify-self: end; height: 18px; margin-top: 3px; background: transparent; box-shadow: none; border-color: var(--h-ring-2); color: var(--h-tx); font-size: 10px; text-transform: lowercase; }
  :global(:is(.fluxFigMenu, .xray)) p { margin: 4px 0; font: 10px/1.5 var(--font-mono); color: var(--h-dim); }
  :global(:is(.fluxFigMenu, .xray)) .status { font: 10px var(--font-mono); color: var(--h-dim); }
  :global(:is(.fluxFigMenu, .xray)) .pane-head { font: 600 9.5px/20px var(--font-mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--h-dim); margin: 0; }
  /* The X-ray's inline palette list reads the X-ray's ramp (re-pointed here, on a host that exists only while it is open). */
  :global(.xray) .cmappick { margin: 2px 0 6px; padding: 0; border: 0; --c-bg: var(--xr-well); --c-bg-raised: var(--xr-card); --c-surface: var(--xr-card); --c-surface-2: color-mix(in oklab, var(--xr-phos) 14%, var(--xr-card)); --c-line: var(--xr-line); --c-line-strong: var(--xr-line);
    --c-accent: var(--xr-phos-hi); --c-accent-bright: var(--xr-phos-hi); --c-accent-tint: var(--xr-tint); --c-tx: var(--xr-tx); --c-tx-hi: var(--xr-hot); --c-tx-2: var(--xr-tx); --c-tx-muted: var(--xr-tx-dim); --c-tx-faint: var(--xr-tx-dim); }
  /* In the menu's wide view the controls stand in the view's own card, the palettes beside them: no box of their own. */
  :global(.fluxFigMenu) .wide .controls, :global(.fluxFigMenu) .wide .notes { padding: 0 4px 0 2px; }
  :global(.fluxFigMenu) .wide .palette-pane { margin-top: 0; }
</style>
