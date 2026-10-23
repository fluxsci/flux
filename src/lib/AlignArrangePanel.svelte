<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import NumberField from "./NumberField.svelte";
  import Logomark from "../shell/Logomark.svelte";
  import { anchorPanel, reanchorPanel, unionRects, type Rect } from "./ui/anchor";
  import {
    alignArrange, closeAlignArrange, switchAlignArrange, alignSelection, distributeSelection,
    setAlignTarget, setAlignReference, reflowArrangement, stepArrangementRows,
    setArrangementGap, setArrangementAnchor, setArrangementLinked, beginArrangementField,
    acceptArrangementField, cancelArrangementField, setArrangementFieldValidity, ownsArrangementField, setArrangementFieldInteraction,
    setPlotAlignReference, setPlotAlignChoice, alignPlotSpines, setAlignArrangeHover,
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
  $: anchorChoices = state?.topology === "row"
    ? [{ x: 0, y: state.anchor.y, label: "Left" }, { x: .5, y: state.anchor.y, label: "Center" }, { x: 1, y: state.anchor.y, label: "Right" }]
    : state?.topology === "column"
      ? [{ x: state.anchor.x, y: 0, label: "Top" }, { x: state.anchor.x, y: .5, label: "Center" }, { x: state.anchor.x, y: 1, label: "Bottom" }]
      : [0, .5, 1].flatMap(y => [0, .5, 1].map(x => ({ x, y, label: y === .5 && x === .5 ? "Center" : `${y === 0 ? "Top" : y === 1 ? "Bottom" : "Middle"} ${x === 0 ? "left" : x === 1 ? "right" : "center"}` })));

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
    if (!(target instanceof Element) || target.closest(".align-arrange-panel, [data-arrange-gap]")) return;
    const consume = state.count > 0 && !!target.closest(".canvas-host");
    closeAlignArrange();
    if (consume) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  function action(e: MouseEvent, run: () => void) { run(); if (e.detail > 0) focusSurface(); }
  function activate(mode: "align" | "arrange") { if (state?.mode !== mode) switchAlignArrange(mode); }
  function align(e: MouseEvent, kind: AlignKind) { action(e, () => { activate("align"); alignSelection(kind); }); }
  function hover(kind: Parameters<typeof setAlignArrangeHover>[0]) { setAlignArrangeHover(kind); }
  function anchorKey(e: KeyboardEvent, i: number) {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? (anchorChoices.length === 9 ? 3 : 1) : e.key === "ArrowUp" ? (anchorChoices.length === 9 ? -3 : -1) : 0;
    if (!delta) return;
    e.preventDefault(); e.stopPropagation();
    const next = (i + delta + anchorChoices.length) % anchorChoices.length;
    const choice = anchorChoices[next];
    setArrangementAnchor(choice.x as 0 | .5 | 1, choice.y as 0 | .5 | 1);
    panel.querySelectorAll<HTMLButtonElement>(".anchor-choice")[next]?.focus();
  }
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
    <header><Logomark size={16} /><h2>Align &amp; Arrange</h2><span class="count">{state.count} {state.count === 1 ? "object" : "objects"}</span><button class="close" aria-label="Close alignment tool" title="Close and keep changes" on:click={() => closeAlignArrange()}>×</button></header>
    {#if state.blockedReason}<p class="notice" role="status">{state.blockedReason}</p>{/if}
    {#if state.excludedCount}<p class="exclusions">{state.excludedCount} locked or hidden {state.excludedCount === 1 ? "object excluded" : "objects excluded"}</p>{/if}
    <div class="body">
      <!-- Both panes stay visible; a control activates its keyboard owner before editing. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tool-pane align-pane" class:active={state.mode === "align"} on:pointerdown|capture={()=>activate("align")} on:focusin={()=>activate("align")}>
        <button class="pane-title" aria-pressed={state.mode === "align"} on:click={(e)=>action(e,()=>activate("align"))}>Align<span>{state.mode === "align" ? "Keyboard active" : ""}</span></button>
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
        <button class="pane-title" aria-pressed={state.mode === "arrange"} disabled={arrangeDisabled} on:click={(e)=>action(e,()=>activate("arrange"))}>Arrange<span>{state.mode === "arrange" ? "Keyboard active" : ""}</span></button>
        <div class="pane-content">
          <div class="topologies" aria-label="Arrangement layout">
            {#each [
              {id:"row",label:"Row",key:"A",path:"M3 9h5v14H3ZM13 9h5v14h-5ZM23 9h5v14h-5Z"},
              {id:"grid",label:"Grid",key:"G",path:"M6 6h8v8H6ZM18 6h8v8h-8ZM6 18h8v8H6ZM18 18h8v8h-8Z"},
              {id:"column",label:"Column",key:"A",path:"M9 3h14v5H9ZM9 13h14v5H9ZM9 23h14v5H9Z"}
            ] as layout}<button class:current={state.topology===layout.id} aria-pressed={state.topology===layout.id} disabled={arrangeDisabled} title={`Reflow as ${layout.label.toLowerCase()} (${layout.key})`} on:click={(e)=>action(e,()=>reflowArrangement(layout.id as "row"|"grid"|"column"))}><svg viewBox="0 0 32 32" aria-hidden="true"><path d={layout.path}/></svg><span>{layout.label}</span><kbd>{layout.key}</kbd></button>{/each}
          </div>
          <div class="shape-row"><span><strong>{state.rows} × {state.cols}</strong></span><div class="stepper"><button disabled={arrangeDisabled || state.rows<=1} aria-label="Fewer rows" title="Fewer rows (F)" on:click={(e)=>action(e,()=>stepArrangementRows(-1))}>−<kbd>F</kbd></button><span>rows</span><button disabled={arrangeDisabled || state.rows>=state.count} aria-label="More rows" title="More rows (D)" on:click={(e)=>action(e,()=>stepArrangementRows(1))}>+<kbd>D</kbd></button></div></div>
          <section class="spacing"><h3>Spacing<span class="section-note">Drag guides · negative overlaps</span></h3><div class="gap-fields">
            {#if state.topology!=="column"}<div on:focusin={()=>hover("gap-x")} on:focusout={()=>hover(null)}><NumberField label={state.topology==="grid"?"Column gap":"Horizontal gap"} value={state.gapX} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("x")} title="Horizontal spacing in canvas pixels; negative values overlap"/></div>{/if}
            {#if state.topology!=="row"}<div on:focusin={()=>hover("gap-y")} on:focusout={()=>hover(null)}><NumberField label={state.topology==="grid"?"Row gap":"Vertical gap"} value={state.gapY} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("y")} title="Vertical spacing in canvas pixels; negative values overlap"/></div>{/if}
          </div>{#if state.topology==="grid"}<label class="link-gaps"><input type="checkbox" checked={state.linkedGaps} on:change={(e)=>setArrangementLinked(e.currentTarget.checked)}/><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 14 4-4M9 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/></svg>Link gaps</label>{/if}</section>
          <section class="anchor-section"><div class="anchor-copy"><h3>Keep fixed</h3><p class="anchor-help" title="Hold W for top, A for left, S for bottom, D for right. Combine keys for a corner; release to return to the selected anchor.">Hold <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><br/>while dragging or scrolling</p></div><div class="anchor-options" class:grid={state.topology==="grid"} class:column={state.topology==="column"} role="radiogroup" aria-label="Keep fixed">
            {#each anchorChoices as choice,i}<button class="anchor-choice" class:chosen={state.anchor.x===choice.x&&state.anchor.y===choice.y} role="radio" aria-checked={state.anchor.x===choice.x&&state.anchor.y===choice.y} tabindex={state.anchor.x===choice.x&&state.anchor.y===choice.y?0:-1} aria-label={choice.label} title={choice.label} disabled={arrangeDisabled} on:keydown={(e)=>anchorKey(e,i)} on:click={(e)=>action(e,()=>setArrangementAnchor(choice.x as 0|.5|1,choice.y as 0|.5|1))}><span aria-hidden="true"></span></button>{/each}
          </div></section>
          <p class="status" role="status">{state.status || `Existing ${state.topology}`}</p>
        </div>
      </div>
    </div>
    <footer><button disabled={state.mode==="align"&&arrangeDisabled} on:click={(e)=>action(e,()=>switchAlignArrange(state!.mode==="align"?"arrange":"align"))}><kbd>Space</kbd> switch to {state.mode==="align"?"Arrange":"Align"}</button>{#if state.mode==="arrange"}<button class="apply" on:click={()=>closeAlignArrange()}><kbd>↵</kbd> Apply</button>{/if}<button on:click={()=>closeAlignArrange(true)}><kbd>Esc</kbd> {state.mode==="arrange"?"Cancel":"Close"}</button></footer>
  </div>
{/if}
<style>
  .align-arrange-panel {position:fixed;z-index:80;width:476px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);display:flex;flex-direction:column;visibility:hidden;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-ui,4px);box-shadow:var(--elev-3);color:var(--c-tx);font:12px var(--font-ui);outline:none;}
  .align-arrange-panel.placed {visibility:visible}
  header {display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--c-bg-raised);border-bottom:1px solid var(--c-line)}
  h2 {margin:0;font:600 16px var(--font-serif);color:var(--c-tx-hi)}
  .count {margin-left:auto;color:var(--c-tx-muted);font:10px var(--font-mono);white-space:nowrap}
  button {border:1px solid transparent;border-radius:var(--r-ui,3px);background:transparent;color:var(--c-tx);font:11px var(--font-ui);cursor:var(--cursor-cross-hover)}
  button:hover:not(:disabled) {background:var(--c-bg-raised);border-color:var(--c-line-strong);color:var(--c-tx-hi)}
  button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible {outline:2px solid var(--c-layout-gap);outline-offset:1px}
  button:disabled {opacity:.35;cursor:var(--cursor-cross)}
  .close {width:22px;height:22px;padding:0;font-size:20px;color:var(--c-tx-muted)}
  .body {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow:auto;min-height:0}
  .tool-pane {min-width:0}.arrange-pane {border-left:1px solid var(--c-line-strong)}
  .pane-title {display:flex;align-items:center;justify-content:space-between;width:100%;padding:8px 11px;border:0;border-bottom:2px solid var(--c-line);border-radius:0;font:600 15px var(--font-serif);color:var(--c-tx-muted);text-align:left}
  .pane-title span {font:9px var(--font-ui);color:var(--c-tx-muted)}
  .active .pane-title {border-bottom-color:var(--c-layout-gap);color:var(--c-layout-gap)}
  .pane-content {padding:10px}
  .select-row {display:flex;align-items:center;gap:7px;margin:0 0 8px;font-size:10px;color:var(--c-tx-muted)}
  .select-row>span {flex:0 0 auto;max-width:60px}
  select {min-width:0;flex:1;height:25px;padding:0 5px;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line);border-radius:var(--r-ui,3px);font:11px var(--font-ui)}
  .align-pad {display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:9px 0 2px}
  .alignment {display:flex;align-items:center;justify-content:center;gap:8px;height:38px;background:var(--c-bg-raised);border-color:var(--c-line)}
  svg {width:23px;height:23px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  kbd {font:10px var(--font-mono);color:var(--c-tx-muted)}.active kbd {color:var(--c-layout-gap)}
  section {margin-top:11px;padding-top:10px;border-top:1px solid var(--c-line)}
  h3 {margin:0 0 7px;font:600 12px var(--font-serif);color:var(--c-tx-hi)}
  .section-note {display:block;margin-top:3px;color:var(--c-tx-muted);font:10px var(--font-ui)}
  .two,.spine-buttons {display:flex;gap:4px}
  .two button,.spine-buttons button {display:flex;align-items:center;justify-content:center;gap:5px;flex:1;min-width:0;height:33px;padding:2px 4px;background:var(--c-bg-raised);border-color:var(--c-line);font-size:10px}
  .two svg {width:23px;height:23px}.spine-buttons svg {width:32px;height:23px}.spine {stroke:var(--flx-green-400,var(--c-accent))}
  .hint,.notice,.exclusions {font-size:10px;line-height:1.4;color:var(--c-tx-muted);margin:7px 0}
  .notice,.exclusions {margin:0;padding:7px 10px;border-bottom:1px solid var(--c-line)}
  .plots-section .select-row {margin-top:8px}
  details {margin-top:8px;font-size:10px}summary {cursor:var(--cursor-cross-hover);color:var(--c-tx-2);padding:3px 0}
  .plot-choice {margin-top:9px}.plot-choice strong {display:block;font-size:10px;margin-bottom:5px}
  .topologies {display:flex;gap:4px}.topologies button {flex:1;min-width:0;position:relative;display:flex;align-items:center;justify-content:center;gap:4px;height:38px;padding:3px;background:var(--c-bg-raised);border-color:var(--c-line);font-size:10px}
  .topologies svg {width:18px;height:18px}.topologies kbd {position:absolute;right:3px;top:1px;font-size:8px}.topologies button.current {border-color:var(--c-layout-gap);color:var(--c-tx-hi)}
  .shape-row {display:flex;align-items:center;justify-content:space-between;margin:7px 0 0;color:var(--c-tx-muted);font-size:10px}.shape-row strong {color:var(--c-tx);font:11px var(--font-mono)}
  .stepper {display:flex;align-items:center;gap:5px}.stepper button {display:flex;align-items:center;gap:5px;height:23px;padding:0 5px;font-size:15px}.stepper kbd {font-size:8px}
  .gap-fields {display:flex;gap:9px}.gap-fields>div {flex:1;min-width:0}.gap-fields :global(.nf) {margin:0}.gap-fields :global(.nf .lb) {font-size:10px}.gap-fields :global(.nf input) {font-size:11px;height:26px}
  .link-gaps {display:flex;align-items:center;gap:5px;margin-top:8px;color:var(--c-tx-muted);font-size:10px}.link-gaps input {accent-color:var(--c-layout-gap);width:12px;height:12px;margin:0}.link-gaps svg {width:13px;height:13px}
  .anchor-section {display:flex;align-items:center;justify-content:space-between;gap:8px}.anchor-copy h3 {margin-bottom:5px}.anchor-help {font:9px/1.5 var(--font-ui);color:var(--c-tx-muted);margin:0;white-space:nowrap}.anchor-help kbd {margin:0 2px;font-size:9px}
  .anchor-options {display:flex;gap:0;padding:2px;border:1px solid var(--c-line-strong);border-radius:3px;background:var(--c-bg-raised)}
  .anchor-options.grid {display:grid;grid-template-columns:repeat(3,20px);gap:0}.anchor-options.column {flex-direction:column}
  .anchor-choice {display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:2px}
  .anchor-choice span {width:3px;height:3px;border-radius:50%;background:var(--c-tx-muted)}.anchor-choice.chosen {background:var(--c-bg)}.anchor-choice.chosen span {width:7px;height:7px;background:var(--c-layout-gap)}
  .status {font:9px var(--font-ui);color:var(--c-tx-muted);margin:8px 0 0;text-align:right}
  footer {display:flex;align-items:center;gap:12px;padding:7px 10px;border-top:1px solid var(--c-line);background:var(--c-bg-raised)}
  footer button {padding:0;font-size:10px;color:var(--c-tx-muted)}footer button:last-child {margin-left:auto}footer kbd {margin-right:3px;color:var(--c-layout-gap)}footer .apply {color:var(--c-tx-hi)}
  @media(max-width:500px) {.align-arrange-panel {width:310px}.body {grid-template-columns:minmax(0,1fr)}.arrange-pane {border-left:0;border-top:1px solid var(--c-line-strong)}.pane-content {padding:9px 11px}.align-pad {grid-template-columns:repeat(6,1fr)}.alignment {gap:3px}.alignment svg {width:20px;height:20px}.alignment kbd {font-size:8px}.pane-title {padding:7px 11px}.topologies button {height:32px}}
</style>
