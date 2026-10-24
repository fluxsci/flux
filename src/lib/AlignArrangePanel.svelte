<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import NumberField from "./NumberField.svelte";
  import ArrangementAnchorPicker from "./ArrangementAnchorPicker.svelte";
  import Logomark from "../shell/Logomark.svelte";
  import { anchorPanel, reanchorPanel, unionRects, type Rect } from "./ui/anchor";
  import {
    alignArrange, closeAlignArrange, switchAlignArrange, alignSelection, distributeSelection,
    setAlignTarget, setAlignReference, reflowArrangement, stepArrangementRows,
    setArrangementGap, setArrangementAnchor, setArrangementLinked, beginArrangementField,
    acceptArrangementField, cancelArrangementField, setArrangementFieldValidity, ownsArrangementField, setArrangementFieldInteraction,
    setPlotAlignReference, setPlotAlignChoice, alignPlotSpines, setAlignArrangeHover,
    canMatchPlotAreas,matchSelectedPlotAreas,
  } from "./interact/alignArrange";
  import type { AlignKind } from "./geometry";

  export let active = true;
  let panel: HTMLDivElement;
  let placed = false;
  let plotDetailsOpen = false;
  const detailState = { signature: "" };
  let position = { x: 0, y: 0 };
  const pointer = { x: -1, y: -1 };
  const lifecycle = { id: -1, open: false };
  let observer: ResizeObserver | null = null;
  let avoid: Rect | null = null;
  let openingPoint: { x: number; y: number } | null = null;
  $: state = active && $alignArrange?.panelVisible !== false ? $alignArrange : null;
  $: blocked = !state || !!state.blockedReason;
  $: arrangeDisabled = blocked || (state?.count ?? 0) < 2;
  $: matchEnabled = !!state && canMatchPlotAreas();


  $: if (state && (!lifecycle.open || lifecycle.id !== state.id)) {
    lifecycle.open = true; lifecycle.id = state.id;
    void place(state.id);
  }
  $: if (!state && lifecycle.open) {
    if (!active && $alignArrange?.id === lifecycle.id) closeAlignArrange();
    lifecycle.open = false; placed = false;
    observer?.disconnect(); observer = null;
  }
  $: if (state?.plot) {
    const signature = `${state.id}:${state.plot.units.map(u => `${u.id}:${u.choiceX}:${u.choiceY}:${u.optionsX.length}:${u.optionsY.length}`).join("|")}`;
    if (signature !== detailState.signature) {
      detailState.signature = signature;
      if (state.plot.units.some(u => (!u.choiceX && u.optionsX.length > 0) || (!u.choiceY && u.optionsY.length > 0))) plotDetailsOpen = true;
    }
  }
  function focusSurface() { void tick().then(() => { if (state) panel?.focus({ preventScroll: true }); }); }
  async function place(id: number) {
    placed = false;
    await tick();
    if (!state || state.id !== id || !panel) return;
    const host = panel.closest(".figure-mode, .slide-mode");
    const boxes = [...(host ?? document).querySelectorAll(".canvas-host .sel-box")].map(n => {
      const b = n.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height };
    }).filter(b => b.w > 0 && b.h > 0);
    avoid = unionRects(boxes);
    openingPoint = pointer.x < 0 ? null : { ...pointer };
    const p = anchorPanel({ avoid, point: openingPoint, size: { w: panel.offsetWidth, h: panel.offsetHeight }, viewport: { w: innerWidth, h: innerHeight } });
    position = { x: p.x, y: p.y }; placed = true;
    observer?.disconnect(); observer = new ResizeObserver(reposition); observer.observe(panel);
    focusSurface();
  }
  function reposition() {
    if (!state || !placed || !panel) return;
    position = reanchorPanel(position, { avoid, point: openingPoint, size: { w: panel.offsetWidth, h: panel.offsetHeight }, viewport: { w: innerWidth, h: innerHeight } });
  }
  function outside(e: PointerEvent) {
    if (!state || state.dragging || e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element) || target.closest(".align-arrange-panel, [data-arrange-gap], .arrangement-anchor-control")) return;
    const consume = state.count > 0 && !!target.closest(".canvas-host");
    closeAlignArrange();
    if (consume) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  function action(e: MouseEvent, run: () => void) { run(); if (e.detail > 0) focusSurface(); }
  function activate(mode: "align" | "arrange") { if (state?.mode !== mode) switchAlignArrange(mode); }
  function align(e: MouseEvent, kind: AlignKind) { action(e, () => { activate("align"); alignSelection(kind); }); }
  function hover(kind: Parameters<typeof setAlignArrangeHover>[0]) { setAlignArrangeHover(kind); }
  const fieldOwner = (axis: "x" | "y") => ({
    begin: (kind?: "typing" | "wheel" | "scrub") => { activate("arrange"); beginArrangementField(axis, kind); }, interaction: (kind: "typing" | "wheel" | "scrub" | null) => setArrangementFieldInteraction(axis, kind), owns: () => ownsArrangementField(axis),
    preview: (v: number | undefined) => { if (v !== undefined) setArrangementGap(axis, v); },
    accept: acceptArrangementField, cancel: cancelArrangementField, validity: setArrangementFieldValidity,
  });
  onDestroy(() => { observer?.disconnect(); if (lifecycle.open && $alignArrange?.id === lifecycle.id) closeAlignArrange(); });
</script>

<svelte:window on:pointermove={(e) => { pointer.x = e.clientX; pointer.y = e.clientY; }} on:pointerdown|capture={outside} on:resize={reposition} />

{#if state}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
  <div class="align-arrange-panel" class:placed bind:this={panel} tabindex="-1" role="dialog" aria-label={state.mode === "align" ? "Flux Align" : "Flux Arrange"} data-command-scope="align-arrange" style={`left:${position.x}px;top:${position.y}px;`} on:pointerdown|stopPropagation>
    <header><Logomark size={14} /><h2>Align &amp; Arrange</h2><span class="count">{state.count} {state.count === 1 ? "object" : "objects"}</span><button class="close" aria-label="Close alignment tool" title="Close and keep changes" on:click={() => closeAlignArrange()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></header>
    {#if state.blockedReason}<p class="notice" role="status">{state.blockedReason}</p>{/if}
    {#if state.excludedCount}<p class="exclusions">{state.excludedCount} locked or hidden {state.excludedCount === 1 ? "object excluded" : "objects excluded"}</p>{/if}
    <div class="body">
      <!-- Both panes stay visible; a control activates its keyboard owner before editing. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tool-pane align-pane" class:active={state.mode === "align"} on:pointerdown|capture={()=>activate("align")} on:focusin={()=>activate("align")}>
        <button class="pane-title" aria-pressed={state.mode === "align"} title={state.mode === "align" ? "The keyboard drives Align" : "Use Align (Space)"} on:click={(e)=>action(e,()=>activate("align"))}>Align{#if state.mode === "align"}<span class="keys">keys</span>{/if}</button>
        <div class="pane-content">
          <label class="select-row"><span>To</span><select aria-label="Align to" disabled={blocked || state.count === 0} value={state.alignTarget} on:change={(e) => setAlignTarget(e.currentTarget.value as "selection" | "reference" | "figure")}><option value="selection" disabled={state.count < 2}>Selection bounds</option><option value="reference" disabled={state.count < 2}>Reference object</option><option value="figure">Figure</option></select></label>
          {#if state.alignTarget === "reference"}<label class="select-row"><span>Reference</span><select aria-label="Alignment reference object" value={state.referenceId} on:change={(e) => setAlignReference(e.currentTarget.value)}>{#each state.units as unit}<option value={unit.id}>{unit.label}</option>{/each}</select></label>{/if}
          <div class="align-pad" aria-label="Align object edges and centers">
            {#each [
              {kind:"left",key:"A",label:"Left",path:"M6 5v22M10 10h15v5H10M10 20h10v5H10"},
              {kind:"centerH",key:"H",label:"X centers",path:"M16 3v26M7 8h18v6H7ZM11 19h10v6H11Z"},
              {kind:"right",key:"D",label:"Right",path:"M26 5v22M7 10h15v5H7M12 20h10v5H12"},
              {kind:"top",key:"W",label:"Top",path:"M5 6h22M10 10v15h5V10M20 10v10h5V10"},
              {kind:"centerV",key:"V",label:"Y centers",path:"M3 16h26M8 7h6v18H8ZM19 11h6v10h-6Z"},
              {kind:"bottom",key:"S",label:"Bottom",path:"M5 26h22M10 7v15h5V7M20 12v10h5V12"}
            ] as item}
              <button class={`alignment ${item.kind}`} disabled={blocked || !state.count} aria-label={`Align ${item.label.toLowerCase()}`} title={`Align ${item.label.toLowerCase()} (${item.key})`} on:click={(e)=>align(e,item.kind as AlignKind)} on:mouseenter={()=>hover(item.kind as AlignKind)} on:mouseleave={()=>hover(null)} on:focus={()=>hover(item.kind as AlignKind)} on:blur={()=>hover(null)}><svg viewBox="0 0 32 32" aria-hidden="true"><path d={item.path}/></svg><kbd>{item.key}</kbd></button>
            {/each}
          </div>
          <section class="distribution"><h3>Even spacing</h3><div class="two">
            <button disabled={blocked || state.count < 3} aria-label="Distribute horizontal spacing" title="Even horizontal spacing; keep outermost objects fixed" on:click={(e)=>action(e,()=>distributeSelection("h"))}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 6v20M28 6v20M13 9h6v14h-6ZM6 16h5m10 0h5"/></svg><span>Horizontal</span></button>
            <button disabled={blocked || state.count < 3} aria-label="Distribute vertical spacing" title="Even vertical spacing; keep outermost objects fixed" on:click={(e)=>action(e,()=>distributeSelection("v"))}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 4h20M6 28h20M9 13h14v6H9ZM16 6v5m0 10v5"/></svg><span>Vertical</span></button>
          </div></section>
          {#if state.plot}
        <section class="plots-section">
          <h3>Match plot area</h3>
          <div class="match-buttons" data-match-plot-area>
            {#each ["height","width","both"] as dimension}
              <button disabled={!matchEnabled} aria-label={`Match plot area ${dimension}`} on:click={(e)=>action(e,()=>matchSelectedPlotAreas(dimension as "height"|"width"|"both"))}>{dimension[0].toUpperCase()+dimension.slice(1)}</button>
            {/each}
          </div>
          {#if state.matchPanels}<p class="hint" data-match-panel-scope>Matching the selected X-ray panels; other plots use their full data area.</p>{/if}
          <h3>Plot spines</h3>
          <div class="spine-buttons">
            <button disabled={blocked || !state.plot || state.plot.loading || !!state.plot.reasonX} title={state.plot?.reasonX ?? "Align horizontal X spines (X)"} on:click={(e) => action(e,()=>alignPlotSpines("x"))} on:mouseenter={() => hover("plot-x")} on:mouseleave={() => hover(null)} on:focus={() => hover("plot-x")} on:blur={() => hover(null)}><svg viewBox="0 0 56 32" aria-hidden="true"><path d="M6 6v20h19M32 12v14h18" /><path class="spine" d="M6 26h19M32 26h18" /></svg><span>X spines</span><kbd>X</kbd></button>
            <button disabled={blocked || !state.plot || state.plot.loading || !!state.plot.reasonY} title={state.plot?.reasonY ?? "Align vertical Y spines (Y)"} on:click={(e) => action(e,()=>alignPlotSpines("y"))} on:mouseenter={() => hover("plot-y")} on:mouseleave={() => hover(null)} on:focus={() => hover("plot-y")} on:blur={() => hover(null)}><svg viewBox="0 0 56 32" aria-hidden="true"><path d="M15 3v11h26M15 19v10h19" /><path class="spine" d="M15 3v11M15 19v10" /></svg><span>Y spines</span><kbd>Y</kbd></button>
          </div>
          {#if state.plot?.loading}<p class="hint" role="status">Reading selected plot spines…</p>{:else if !state.plot}<p class="hint">Select semantic plots to align their spines.</p>{:else}
            {#if state.plot.units.length}<label class="select-row"><span>Reference</span><select aria-label="Plot alignment reference" value={state.plot.referenceId} on:change={(e) => setPlotAlignReference(e.currentTarget.value)}>{#each state.plot.units as unit}<option value={unit.id}>{unit.label}</option>{/each}</select></label>{/if}
            {#if state.plot.reasonX}<p class="hint">X: {state.plot.reasonX}</p>{/if}
            {#if state.plot.reasonY && state.plot.reasonY !== state.plot.reasonX}<p class="hint">Y: {state.plot.reasonY}</p>{/if}
            {#if state.plot.units.some(u => u.explicitChoice || u.optionsX.length > 1 || u.optionsY.length > 1 || (!u.choiceX && u.optionsX.length > 0) || (!u.choiceY && u.optionsY.length > 0))}
              <details bind:open={plotDetailsOpen}><summary>Plot, panel &amp; spine choices</summary>{#each state.plot.units as unit}<div class="plot-choice"><strong>{unit.label}</strong>{#each ["x","y"] as axis}<label class="select-row"><span>{axis.toUpperCase()} spine</span><select aria-label={`${unit.label} ${axis.toUpperCase()} spine`} value={axis === "x" ? unit.choiceX : unit.choiceY} on:change={(e) => setPlotAlignChoice(unit.id, axis as "x"|"y", e.currentTarget.value)}><option value="">Choose a spine</option>{#each axis === "x" ? unit.optionsX : unit.optionsY as option}<option value={option.value}>{option.label}</option>{/each}</select></label>{/each}</div>{/each}</details>
            {/if}
          {/if}
        </section>
{/if}
        </div>
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tool-pane arrange-pane" class:active={state.mode === "arrange"} on:pointerdown|capture={()=>activate("arrange")} on:focusin={()=>activate("arrange")} on:wheel|capture={(e)=>{if(e.target instanceof Element && e.target.closest(".nf input"))activate("arrange");}}>
        <button class="pane-title" aria-pressed={state.mode === "arrange"} disabled={arrangeDisabled} title={state.mode === "arrange" ? "The keyboard drives Arrange" : "Use Arrange (Space)"} on:click={(e)=>action(e,()=>activate("arrange"))}>Arrange{#if state.mode === "arrange"}<span class="keys">keys</span>{/if}</button>
        <div class="pane-content">
          <div class="topologies" aria-label="Arrangement layout">
            {#each [
              {id:"row",label:"Row",key:"A",path:"M3 9h5v14H3ZM13 9h5v14h-5ZM23 9h5v14h-5Z"},
              {id:"grid",label:"Grid",key:"G",path:"M6 6h8v8H6ZM18 6h8v8h-8ZM6 18h8v8H6ZM18 18h8v8h-8Z"},
              {id:"column",label:"Column",key:"A",path:"M9 3h14v5H9ZM9 13h14v5H9ZM9 23h14v5H9Z"}
            ] as layout}<button class:current={state.topology===layout.id} aria-pressed={state.topology===layout.id} disabled={arrangeDisabled} title={`Reflow as ${layout.label.toLowerCase()} (${layout.key})`} on:click={(e)=>action(e,()=>reflowArrangement(layout.id as "row"|"grid"|"column"))}><svg viewBox="0 0 32 32" aria-hidden="true"><path d={layout.path}/></svg><span>{layout.label}</span><kbd>{layout.key}</kbd></button>{/each}
          </div>
          <div class="shape-row"><span class="shape" title="Rows × columns"><strong>{state.rows}</strong> {state.rows === 1 ? "row" : "rows"} <i>×</i> <strong>{state.cols}</strong> {state.cols === 1 ? "column" : "columns"}</span><div class="stepper" role="group" aria-label="Rows"><button disabled={arrangeDisabled || state.rows<=1} aria-label="Fewer rows" title="Fewer rows (F)" on:click={(e)=>action(e,()=>stepArrangementRows(-1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8"/></svg></button><button disabled={arrangeDisabled || state.rows>=state.count} aria-label="More rows" title="More rows (D)" on:click={(e)=>action(e,()=>stepArrangementRows(1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8M8 4v8"/></svg></button></div></div>
          <section class="spacing"><h3>Spacing</h3><div class="gap-fields">
            {#if state.topology!=="column"}<div on:focusin={()=>hover("gap-x")} on:focusout={()=>hover(null)}><NumberField label={state.topology==="grid"?"Column gap":"Horizontal gap"} value={state.gapX} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("x")} title="Horizontal spacing in canvas pixels; negative values overlap"/></div>{/if}
            {#if state.topology!=="row"}<div on:focusin={()=>hover("gap-y")} on:focusout={()=>hover(null)}><NumberField label={state.topology==="grid"?"Row gap":"Vertical gap"} value={state.gapY} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("y")} title="Vertical spacing in canvas pixels; negative values overlap"/></div>{/if}
          </div>{#if state.topology==="grid"}<label class="link-gaps"><input type="checkbox" checked={state.linkedGaps} on:change={(e)=>setArrangementLinked(e.currentTarget.checked)}/><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 14 4-4M9 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/></svg>Link gaps</label>{/if}</section>
          <section class="anchor-section" class:grid-anchor={state.topology==="grid"}><h3>Keep fixed</h3><ArrangementAnchorPicker topology={state.topology} anchor={state.anchor} disabled={arrangeDisabled} onchange={setArrangementAnchor}/></section>
        </div>
      </div>
    </div>
    <footer><button class="switch" disabled={state.mode==="align"&&arrangeDisabled} on:click={(e)=>action(e,()=>switchAlignArrange(state!.mode==="align"?"arrange":"align"))}><kbd>Space</kbd>{state.mode==="align"?"Arrange":"Align"}</button><span class="status-line" role="status">{state.mode==="arrange" ? (state.status || `Existing ${state.topology}`) : ""}</span><button class="secondary" on:click={()=>closeAlignArrange(true)}><kbd>Esc</kbd>{state.mode==="arrange"?"Cancel":"Close"}</button>{#if state.mode==="arrange"}<button class="apply" on:click={()=>closeAlignArrange()}><kbd>↵</kbd>Apply</button>{/if}</footer>
  </div>
{/if}
<style>
  /* Flux's tool-surface vocabulary (the Inspector, the Plots rail): mono uppercase eyebrows, quiet
     hints, inset tiles; Align & Arrange's own colour (--c-layout-gap, the canvas gutters' magenta)
     marks state — the pane that owns the keyboard, the chosen layout, the fixed point. */
  .align-arrange-panel {position:fixed;z-index:80;width:476px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);display:flex;flex-direction:column;visibility:hidden;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-panel,3px);box-shadow:var(--elev-3);color:var(--c-tx);font:12px var(--font-ui);outline:none;-webkit-font-smoothing:antialiased}
  .align-arrange-panel.placed {visibility:visible}
  header {display:flex;align-items:center;gap:7px;height:30px;padding:0 4px 0 10px;flex-shrink:0;background:var(--c-bg-raised);border-bottom:1px solid var(--c-line)}
  h2 {margin:0;font:600 12px var(--font-ui);color:var(--c-tx-hi);letter-spacing:.01em}
  .count {margin-left:auto;display:inline-flex;align-items:center;padding:0 7px;height:17px;border-radius:9px;background:var(--c-surface-2);color:var(--c-tx-muted);font:10px var(--font-mono);white-space:nowrap}
  button {border:1px solid transparent;border-radius:var(--r-ui,2px);background:transparent;color:var(--c-tx-2);font:11px var(--font-ui);cursor:var(--cursor-cross-hover);transition:background-color 80ms linear,border-color 80ms linear,color 80ms linear}
  button:hover:not(:disabled) {background:var(--c-surface-2);color:var(--c-tx-hi)}
  button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible {outline:2px solid var(--c-layout-gap);outline-offset:1px}
  button:disabled {opacity:.35;cursor:var(--cursor-cross)}
  .close {display:grid;place-items:center;width:22px;height:22px;padding:0;color:var(--c-tx-muted)}
  .close svg {width:12px;height:12px;stroke-width:1.5}
  .body {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:auto;min-height:0}
  .tool-pane {min-width:0}.arrange-pane {border-left:1px solid var(--c-line)}
  .pane-title {display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 10px;border:0;border-bottom:1px solid var(--c-line);border-radius:0;box-shadow:inset 0 -2px 0 transparent;color:var(--c-tx-muted);font:600 10px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;text-align:left}
  .pane-title:hover:not(:disabled) {background:transparent}
  .active .pane-title {color:var(--c-layout-gap);box-shadow:inset 0 -2px 0 var(--c-layout-gap)}
  .keys {margin-left:auto;padding:0 5px;height:15px;line-height:15px;border-radius:var(--r-ui,2px);background:var(--c-layout-gap-tint);color:var(--c-layout-gap);font:600 9px var(--font-mono);letter-spacing:.06em}
  .pane-content {padding:10px}
  .select-row {display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:10.5px;color:var(--c-tx-muted)}
  .select-row>span {flex:0 0 auto;max-width:64px}
  select {min-width:0;flex:1;height:24px;padding:0 5px;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line);border-radius:var(--r-ui,2px);font:11px var(--font-ui)}
  select:hover:not(:disabled) {border-color:var(--c-line-strong)}
  svg {width:20px;height:20px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  /* Shortcut hints whisper in the corner; brighter only where the keyboard is (the active pane). */
  kbd {font:9px var(--font-mono);color:var(--c-tx-faint)}
  .active kbd {color:var(--c-tx-muted)}
  /* Tiles: inset wells (the rail's tiles), a lift on hover, the tool colour when chosen. */
  .align-pad {display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:2px 0 0}
  .alignment,.two button,.spine-buttons button,.match-buttons button,.topologies button {position:relative;background:var(--c-bg);border-color:var(--c-line)}
  .alignment:hover:not(:disabled),.two button:hover:not(:disabled),.spine-buttons button:hover:not(:disabled),.match-buttons button:hover:not(:disabled),.topologies button:hover:not(:disabled) {background:var(--c-surface-2);border-color:var(--c-line-strong)}
  .alignment {display:grid;place-items:center;height:36px;padding:0}
  .alignment kbd,.topologies kbd {position:absolute;right:4px;top:2px;line-height:1}
  section {margin-top:12px;padding-top:10px;border-top:1px solid var(--c-line)}
  h3 {margin:0 0 7px;font:600 9.5px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--c-tx-muted)}
  .two,.spine-buttons,.match-buttons {display:flex;gap:4px}
  .two button,.spine-buttons button,.match-buttons button {display:flex;align-items:center;justify-content:center;gap:6px;flex:1;min-width:0;height:32px;padding:2px 6px;font-size:10.5px}
  .spine-buttons svg {width:30px;height:20px}.spine {stroke:var(--flx-green-400,var(--c-accent))}
  .spine-buttons kbd {margin-left:auto}
  .hint,.notice,.exclusions {font-size:10.5px;line-height:1.45;color:var(--c-tx-muted);margin:7px 0}
  .notice,.exclusions {margin:0;padding:6px 10px;border-bottom:1px solid var(--c-line);background:var(--c-bg-raised)}
  .notice {color:var(--c-tx-2)}
  .plots-section .select-row {margin-top:8px}
  details {margin-top:8px;font-size:10.5px}summary {cursor:var(--cursor-cross-hover);color:var(--c-tx-2);padding:3px 0}
  summary:hover {color:var(--c-tx-hi)}
  .plot-choice {margin-top:9px}.plot-choice strong {display:block;font-size:10.5px;margin-bottom:5px;color:var(--c-tx-hi)}
  .topologies {display:flex;gap:4px}.topologies button {flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:5px;height:34px;padding:3px;font-size:10.5px}
  .topologies svg {width:16px;height:16px}
  .topologies button.current {background:var(--c-layout-gap-tint);border-color:var(--c-layout-gap);color:var(--c-tx-hi)}
  .topologies button.current svg {color:var(--c-layout-gap)}
  .shape-row {display:flex;align-items:center;justify-content:space-between;margin:8px 0 0;color:var(--c-tx-muted);font-size:10.5px}
  .shape strong {color:var(--c-tx-hi);font:600 11px var(--font-mono)}.shape i {font-style:normal;color:var(--c-tx-faint);margin:0 2px}
  .stepper {display:inline-flex;border:1px solid var(--c-line);border-radius:var(--r-ui,2px);overflow:hidden}
  .stepper button {display:grid;place-items:center;width:24px;height:20px;padding:0;border:0;border-radius:0;background:var(--c-bg)}
  .stepper button + button {border-left:1px solid var(--c-line)}
  .stepper svg {width:12px;height:12px}
  .gap-fields {display:flex;gap:8px}.gap-fields>div {flex:1;min-width:0}.gap-fields :global(.nf) {margin:0}.gap-fields :global(.nf .lb) {font-size:10.5px}.gap-fields :global(.nf input) {font-size:11px;height:24px}
  .link-gaps {display:inline-flex;align-items:center;gap:5px;margin-top:8px;color:var(--c-tx-muted);font-size:10.5px;cursor:var(--cursor-cross-hover)}.link-gaps:hover {color:var(--c-tx-hi)}
  .link-gaps input {accent-color:var(--c-layout-gap);width:12px;height:12px;margin:0}.link-gaps svg {width:13px;height:13px}
  .anchor-section h3 {margin-bottom:7px}.anchor-section.grid-anchor {display:flex;align-items:center;justify-content:space-between}.anchor-section.grid-anchor h3 {margin:0}
  /* Footer: key chips, the status between, the primary action last. */
  footer {display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;flex-shrink:0;border-top:1px solid var(--c-line);background:var(--c-bg-raised)}
  footer button {display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;color:var(--c-tx-2);font-size:11px}
  footer kbd {display:inline-block;padding:0 4px;height:15px;line-height:14px;border:1px solid var(--c-line-strong);border-bottom-width:1.5px;border-radius:3px;background:var(--c-surface);color:var(--c-tx-2);font-size:9px}
  .status-line {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--c-tx-faint);font:10px var(--font-mono);padding-right:4px}
  footer .apply {background:var(--c-layout-gap-tint);border-color:color-mix(in oklab,var(--c-layout-gap) 55%,transparent);color:var(--c-tx-hi)}
  footer .apply:hover:not(:disabled) {background:color-mix(in oklab,var(--c-layout-gap) 26%,transparent);border-color:var(--c-layout-gap)}
  footer .apply kbd {border-color:color-mix(in oklab,var(--c-layout-gap) 55%,transparent)}
  @media(max-width:500px) {.align-arrange-panel {width:310px}.body {grid-template-columns:minmax(0,1fr)}.arrange-pane {border-left:0;border-top:1px solid var(--c-line)}.pane-content {padding:9px 10px}.align-pad {grid-template-columns:repeat(6,1fr)}.alignment svg {width:18px;height:18px}.alignment kbd {display:none}.topologies button {height:32px}.status-line {display:none}}
  @media (prefers-reduced-motion: reduce) {button {transition:none}}
</style>
