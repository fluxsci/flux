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
  /** Armed from the property menu (f, then v/b): the wheel adjusts the focused
   *  limit wherever the mouse is, Space accepts min → max → done, Enter is done. */
  export let armed = false;
  export let onDone: (() => void) | undefined = undefined;
  const limitFields: NumberField[] = [];
  let limitSlots: { key: string; end: number }[] = [];
  $: limitSlots = (usable && defaults ? (axis ? [axis] : plotAxisKeys(manifest)) : []).flatMap(key => [0, 1].map(end => ({ key, end })));
  function focusedLimit(): number {
    const inputs = [...(host?.querySelectorAll<HTMLInputElement>('[data-axis-view-row] input') ?? [])];
    return inputs.indexOf(document.activeElement as HTMLInputElement);
  }
  function onWinWheel(e: WheelEvent) {
    if (!armed) return;
    const i = focusedLimit();
    if (i < 0 || !limitFields[i]) return;
    e.preventDefault();
    e.stopPropagation(); // the canvas must not zoom, the menu body must not scroll
    limitFields[i].wheelBy(e);
  }
  async function advance(key: string, end: number) {
    if (end === 0) {
      await tick();
      const input = host?.querySelectorAll<HTMLInputElement>(`[data-axis-view-row="${key}"] input`)[1];
      if (input && !input.disabled) { input.focus(); input.select(); return; }
    }
    onDone?.();
  }
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

<svelte:window on:wheel|capture|nonpassive={onWinWheel} />

<div class="axis-view" data-axis-view bind:this={host}>
  {#if !axis}<div class="heading">Axis view</div>{/if}
  {#if usable && defaults}
    {#each (axis ? [axis] : plotAxisKeys(manifest)) as key}
      <div class="axis-row" data-axis-view-row={key}>
        <span class="axis-name" title={key === 'y2' ? 'the right (twin) value axis' : key === 'x2' ? 'the top (twin) value axis' : undefined}>{key}</span>
        {#each [0, 1] as end}
          <NumberField bind:this={limitFields[limitSlots.findIndex(s => s.key === key && s.end === end)]} advanceOnSpace={armed}
            on:advance={() => advance(key, end)} on:done={() => onDone?.()}
            label={end ? 'max' : 'min'} title={`${key} ${end ? 'max' : 'min'} (data units)`}
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

  /* HOSTED in the property menu, under the armed "x view" / "y view" row (2026-11-20): the menu's look, not a
     form set into it. One line: the two limits as numbers in wells, the scale as a choice with the menu's face;
     reset is a quiet key under them. The row above already names the axis. (These rules exist only while that
     row is in hand; the Inspector's look, above, is untouched.) */
  :global(.fluxFigMenu) .axis-view { padding: 0 0 2px 24px; }
  :global(.fluxFigMenu) .axis-row { align-items: center; gap: 4px 9px; margin: 0; min-height: 24px; }
  :global(.fluxFigMenu) .axis-name { display: none; }
  :global(.fluxFigMenu) .axis-view :global(.nf) { flex: 0 1 auto; flex-direction: row; align-items: center; gap: 4px; }
  :global(.fluxFigMenu) .axis-view :global(.nf .lb), :global(.fluxFigMenu) .scale { font: 10.5px var(--font-mono); letter-spacing: 0; color: var(--fm-tx-dim); }
  :global(.fluxFigMenu) .axis-view :global(.nf .lb:hover) { color: var(--fm-blue-hi); }
  :global(.fluxFigMenu) .axis-view :global(.nf input), :global(.fluxFigMenu) select {
    box-sizing: content-box; height: 18px; padding: 0 4px; background: var(--fm-well); border: 0; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.12);
    color: var(--fm-tx-hi); font: 12px/18px var(--font-mono); font-variant-numeric: tabular-nums; outline: none;
  }
  :global(.fluxFigMenu) .axis-view :global(.nf input) { width: 6.5ch; text-align: right; }
  :global(.fluxFigMenu) .axis-view :global(.nf input::placeholder) { color: var(--fm-tx-dim); font-style: italic; }
  :global(.fluxFigMenu) .axis-view :global(.nf input:hover), :global(.fluxFigMenu) select:hover { box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.26); }
  :global(.fluxFigMenu) .axis-view :global(.nf input:focus), :global(.fluxFigMenu) select:focus { box-shadow: inset 0 0 0 1px var(--fm-blue); outline: none; }
  :global(.fluxFigMenu) .scale { flex-direction: row; align-items: center; gap: 4px; font-size: 0; }
  /* The choice's face: no system arrow, a small drawn one (two gradients: nothing to fetch or decode). */
  :global(.fluxFigMenu) select {
    appearance: none; padding: 0 17px 0 6px; font: 12px/18px var(--font-serif); cursor: var(--cursor-cross-hover);
    background-image: linear-gradient(45deg, transparent 50%, var(--fm-tx-dim) 50%), linear-gradient(135deg, var(--fm-tx-dim) 50%, transparent 50%);
    background-position: calc(100% - 10px) 7px, calc(100% - 6px) 7px; background-size: 4px 4px; background-repeat: no-repeat;
  }
  :global(.fluxFigMenu) .reset {
    height: 18px; padding: 0 7px; margin: 3px 0 0; background: transparent; border: 1px solid var(--fm-line-2); border-radius: 5px; color: var(--fm-tx);
    font: 600 10px/1 var(--font-mono); text-transform: lowercase; cursor: var(--cursor-cross-hover);
  }
  :global(.fluxFigMenu) .reset:hover:not(:disabled) { background: var(--fm-paper); border-color: color-mix(in oklab, var(--fm-blue) 45%, transparent); color: var(--fm-blue-deep); }
  :global(.fluxFigMenu) .reset:focus { outline: 1.5px solid var(--fm-blue-hi); outline-offset: 1px; }
  :global(.fluxFigMenu) .reset:disabled { opacity: 0.38; cursor: var(--cursor-cross); }
  :global(.fluxFigMenu) p { margin: 3px 0 0; font: 10px/1.45 var(--font-mono); color: var(--fm-tx-dim); }
</style>
