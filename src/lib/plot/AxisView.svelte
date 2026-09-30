<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { project, mutate } from '../store';
  import { plotManifests } from './store';
  import { setPlotView } from '../ops';
  import { editSession } from '../interact/editSession';
  import { plotViewPatch, plotAxisKeys, type PlotViewFields } from './viewControls';
  import { plotViewIssues, usableAxis } from './project';
  import { axisViewFocus } from './axisViewState';
  import NumberField from '../NumberField.svelte';

  export let elementId: string;
  export let axis: 'x' | 'y' | 'y2' | 'x2' | undefined = undefined;
  export let autofocus = false;
  let host: HTMLDivElement;
  let error = '';
  const session = editSession();
  onDestroy(session.finish);
  $: el = $project.figures.flatMap(f => f.elements).find(e => e.id === elementId);
  $: plot = el?.type === 'plot' ? el : undefined;
  $: manifest = plot ? $plotManifests[plot.assetId] : undefined;
  $: defaults = manifest?.axes?.[0] as (Record<string, { domain: number[]; scale: string } | undefined> & NonNullable<typeof manifest>['axes'][number]) | undefined;
  const axisOf = (key: string) => defaults?.[key] as Parameters<typeof usableAxis>[0] | undefined;
  $: usable = !!defaults && !!manifest?.series?.length;
  $: issues = plotViewIssues(manifest, plot?.view);
  async function focusRow(key: 'x' | 'y' | 'y2' | 'x2') {
    await tick();
    const input = host?.querySelector<HTMLInputElement>(`[data-axis-view-row="${key}"] input`);
    input?.focus(); input?.select();
  }
  $: if ($axisViewFocus?.elementId === elementId && !axis) {
    void focusRow($axisViewFocus.axis);
    axisViewFocus.set(null);
  }
  onMount(() => { if (autofocus) void focusRow(axis ?? 'x'); });
  function apply(fields: PlotViewFields) {
    if (!plot) return;
    try {
      const patch = plotViewPatch(plot.view, manifest, fields);
      mutate(p => setPlotView(p, elementId, patch, defaults));
      error = '';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  function stepFor(domain: readonly number[] | undefined) {
    const span = domain ? Math.abs(domain[1] - domain[0]) : 0;
    return span > 0 && Number.isFinite(span) ? 10 ** Math.floor(Math.log10(span) - 2) : 1;
  }
  function choose(fields: PlotViewFields) { session.run(() => apply(fields)); session.finish(); }
</script>

<div class="axis-view" data-axis-view bind:this={host}>
  {#if !axis}<div class="heading">Axis view</div>{/if}
  {#if usable && defaults}
    {#each (axis ? [axis] : plotAxisKeys(manifest)) as key}
      <div class="axis-row" data-axis-view-row={key}>
        <span class="axis-name" title={key === 'y2' ? 'the right (twin) value axis' : key === 'x2' ? 'the top (twin) value axis' : undefined}>{key}</span>
        {#each [0, 1] as end}
          <NumberField label={end ? 'max' : 'min'} title={`${key} ${end ? 'max' : 'min'} (data units)`}
            value={plot?.view?.[key]?.domain?.[end] ?? axisOf(key)?.domain?.[end] ?? 0}
            empty={!plot?.view?.[key]?.domain || plot.view[key]!.domain![end] === axisOf(key)?.domain?.[end]}
            placeholder={axisOf(key)?.domain ? String(axisOf(key)!.domain[end]) : "Unavailable"} step={stepFor(axisOf(key)?.domain)} live optional
            disabled={!axisOf(key) || !usableAxis(axisOf(key)!)}
            on:preview={e => apply({ [`${key}${end ? 'Max' : 'Min'}`]: e.detail ?? null })}
            on:scrub={e => apply({ [`${key}${end ? 'Max' : 'Min'}`]: e.detail })} />
        {/each}
        {#if axisOf(key) && usableAxis(axisOf(key)!)}
          <label class="scale">scale<select aria-label={`${key} scale`} value={plot?.view?.[key]?.scale ?? axisOf(key)!.scale}
            on:change={e => choose({ [`${key}Scale`]: e.currentTarget.value })}>
            <option value="linear">linear</option><option value="log">log</option>
          </select></label>
        {/if}
      </div>
    {/each}
    {#if (manifest?.axes?.length ?? 0) > 1}<p>Applies to every panel; defaults shown for the first panel.</p>{/if}
  {:else}<p>This plot has no axes/series to view.</p>{/if}
  <button class="reset" disabled={!plot?.view} on:click={() => choose({ reset: true })}>Reset</button>
  {#if error}<p role="status">{error}</p>{:else if issues.length}<p role="status">{issues.join(' ')}</p>{/if}
</div>

<style>
  .axis-view { min-width: 0; padding: 6px 0; }
  .heading { font: 10px var(--font-mono); color: var(--c-tx-muted); margin-bottom: 6px; }
  .axis-row { display: flex; align-items: end; gap: 5px; margin-bottom: 6px; }
  .axis-name { font: 12px var(--font-mono); padding-bottom: 5px; }
  .scale { display: flex; flex-direction: column; gap: 2px; font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  select, .reset { height: 24px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx); font: 11px var(--font-mono); padding: 0 4px; }
  select:focus, .reset:focus { outline: 1px solid var(--c-accent); }
  .reset:disabled { opacity: .5; }
  p { font: 11px var(--font-ui); color: var(--c-tx-muted); margin: 4px 0; }
</style>
