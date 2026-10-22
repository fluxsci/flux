<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import NumberField from "./NumberField.svelte";
  import Logomark from "../shell/Logomark.svelte";
  import { anchorPanel, reanchorPanel, unionRects, type Rect } from "./ui/anchor";
  import {
    alignArrange, closeAlignArrange, switchAlignArrange, alignSelection, distributeSelection,
    setAlignTarget, setAlignReference, reflowArrangement, stepArrangementRows,
    setArrangementGap, setArrangementAnchor, setArrangementLinked, beginArrangementField,
    acceptArrangementField, cancelArrangementField, setArrangementFieldValidity, ownsArrangementField,
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
  $: state = active ? $alignArrange : null;
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
    if ($alignArrange?.id === lifecycle.id) closeAlignArrange();
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
  function align(e: MouseEvent, kind: AlignKind) { action(e, () => alignSelection(kind)); }
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
    begin: () => beginArrangementField(axis), owns: () => ownsArrangementField(axis),
    preview: (v: number | undefined) => { if (v !== undefined) setArrangementGap(axis, v); },
    accept: acceptArrangementField, cancel: cancelArrangementField, validity: setArrangementFieldValidity,
  });
  onDestroy(() => { observer?.disconnect(); if (lifecycle.open && $alignArrange?.id === lifecycle.id) closeAlignArrange(); });
</script>

<svelte:window on:pointermove={(e) => { pointer.x = e.clientX; pointer.y = e.clientY; }} on:pointerdown|capture={outside} on:resize={reposition} />

{#if state}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
  <div class="align-arrange-panel" class:placed bind:this={panel} tabindex="-1" role="dialog" aria-label={state.mode === "align" ? "Flux Align" : "Flux Arrange"} data-command-scope="align-arrange" style={`left:${position.x}px;top:${position.y}px;`} on:pointerdown|stopPropagation>
    <header>
      <Logomark size={17} />
      <h2>Flux {state.mode === "align" ? "Align" : "Arrange"}</h2>
      <span class="count">{state.count} {state.count === 1 ? "object" : "objects"}</span>
      <button class="close" aria-label="Close alignment tool" title="Close and keep changes" on:click={() => closeAlignArrange()}>×</button>
    </header>
    <nav aria-label="Alignment tool view">
      <button class:current={state.mode === "align"} aria-pressed={state.mode === "align"} on:click={(e) => action(e, () => switchAlignArrange("align"))}>Align</button>
      <button class:current={state.mode === "arrange"} aria-pressed={state.mode === "arrange"} disabled={arrangeDisabled} on:click={(e) => action(e, () => switchAlignArrange("arrange"))}>Arrange</button>
    </nav>
    <div class="body">
      {#if state.blockedReason}<p class="notice" role="status">{state.blockedReason}</p>{/if}
      {#if state.excludedCount}<p class="exclusions">{state.excludedCount} locked or hidden {state.excludedCount === 1 ? "object excluded" : "objects excluded"}</p>{/if}
      {#if state.mode === "align"}
        <label class="select-row"><span>Align to</span><select disabled={blocked || state.count === 0} value={state.alignTarget} on:change={(e) => setAlignTarget(e.currentTarget.value as "selection" | "reference" | "figure")}><option value="selection" disabled={state.count < 2}>Selection bounds</option><option value="reference" disabled={state.count < 2}>Reference object</option><option value="figure">Figure</option></select></label>
        {#if state.alignTarget === "reference"}<label class="select-row"><span>Reference</span><select aria-label="Alignment reference object" value={state.referenceId} on:change={(e) => setAlignReference(e.currentTarget.value)}>{#each state.units as unit}<option value={unit.id}>{unit.label}</option>{/each}</select></label>{/if}
        <div class="align-pad" aria-label="Align object edges">
          {#each [{kind:"top",key:"W",label:"Top",path:"M5 6h22M10 10v15h5V10M20 10v10h5V10"},{kind:"left",key:"A",label:"Left",path:"M6 5v22M10 10h15v5H10M10 20h10v5H10"},{kind:"right",key:"D",label:"Right",path:"M26 5v22M7 10h15v5H7M12 20h10v5H12"},{kind:"bottom",key:"S",label:"Bottom",path:"M5 26h22M10 7v15h5V7M20 12v10h5V12"}] as item}
            <button class={`edge ${item.kind}`} disabled={blocked || !state.count} aria-label={`Align ${item.label.toLowerCase()}`} title={`Align ${item.label.toLowerCase()} (${item.key})`} on:click={(e) => align(e, item.kind as AlignKind)} on:mouseenter={() => hover(item.kind as AlignKind)} on:mouseleave={() => hover(null)} on:focus={() => hover(item.kind as AlignKind)} on:blur={() => hover(null)}><svg viewBox="0 0 32 32" aria-hidden="true"><path d={item.path} /></svg><span>{item.label}</span><kbd>{item.key}</kbd></button>
          {/each}
          <span class="pad-center" aria-hidden="true">+</span>
        </div>
        <div class="centers">
          <button disabled={blocked || !state.count} title="Align horizontal centers (H)" on:click={(e) => align(e,"centerH")} on:mouseenter={() => hover("centerH")} on:mouseleave={() => hover(null)} on:focus={() => hover("centerH")} on:blur={() => hover(null)}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3v26M7 8h18v6H7ZM11 19h10v6H11Z" /></svg><span>X centers</span><kbd>H</kbd></button>
          <button disabled={blocked || !state.count} title="Align vertical centers (V)" on:click={(e) => align(e,"centerV")} on:mouseenter={() => hover("centerV")} on:mouseleave={() => hover(null)} on:focus={() => hover("centerV")} on:blur={() => hover(null)}><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h26M8 7h6v18H8ZM19 11h6v10h-6Z" /></svg><span>Y centers</span><kbd>V</kbd></button>
        </div>
        <section class="plots-section">
          <h3>Plot spines <span>Align the axes, keep the labels</span></h3>
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
        <section class="distribution"><h3>Even spacing</h3><div class="two"><button disabled={blocked || state.count < 3} title="Distribute horizontal spacing; keep outermost objects fixed" on:click={(e) => action(e,()=>distributeSelection("h"))}>Horizontal</button><button disabled={blocked || state.count < 3} title="Distribute vertical spacing; keep outermost objects fixed" on:click={(e) => action(e,()=>distributeSelection("v"))}>Vertical</button></div></section>
      {:else}
        <div class="topologies" aria-label="Arrangement layout">
          {#each [{id:"row",label:"Row",symbol:"▯ ▯ ▯"},{id:"grid",label:"Grid",symbol:"⊞"},{id:"column",label:"Column",symbol:"☷"}] as layout}<button class:current={state.topology === layout.id} aria-pressed={state.topology === layout.id} disabled={arrangeDisabled} title={`Reflow as ${layout.label.toLowerCase()}`} on:click={(e)=>action(e,()=>reflowArrangement(layout.id as "row"|"grid"|"column"))}><span class="layout-symbol" aria-hidden="true">{layout.symbol}</span>{layout.label}</button>{/each}
        </div>
        <div class="shape-row"><span>Layout <strong>{state.rows} × {state.cols}</strong></span><div class="stepper"><button disabled={arrangeDisabled || state.rows <= 1} aria-label="Fewer rows" title="Fewer rows (F)" on:click={(e)=>action(e,()=>stepArrangementRows(-1))}>−</button><span>rows</span><button disabled={arrangeDisabled || state.rows >= state.count} aria-label="More rows" title="More rows (D)" on:click={(e)=>action(e,()=>stepArrangementRows(1))}>+</button></div></div>
        <section class="spacing"><h3>Spacing <span>Drag the pink guides on the canvas</span></h3><div class="gap-fields">
          {#if state.topology !== "column"}<div on:focusin={()=>hover("gap-x")} on:focusout={()=>hover(null)}><NumberField label={state.topology === "grid" ? "Column gap" : "Horizontal gap"} value={state.gapX} min={0} live disabled={arrangeDisabled} externalOwner={fieldOwner("x")} title="Horizontal spacing in canvas pixels" /></div>{/if}
          {#if state.topology !== "row"}<div on:focusin={()=>hover("gap-y")} on:focusout={()=>hover(null)}><NumberField label={state.topology === "grid" ? "Row gap" : "Vertical gap"} value={state.gapY} min={0} live disabled={arrangeDisabled} externalOwner={fieldOwner("y")} title="Vertical spacing in canvas pixels" /></div>{/if}
        </div>{#if state.topology === "grid"}<label class="link-gaps"><input type="checkbox" checked={state.linkedGaps} on:change={(e)=>setArrangementLinked(e.currentTarget.checked)} />Link horizontal and vertical gaps</label>{/if}</section>
        <section class="anchor-section"><h3>Keep fixed <span>Spacing grows away from this point</span></h3><div class="anchor-options" class:grid={state.topology === "grid"} role="radiogroup" aria-label="Keep fixed">
          {#each anchorChoices as choice,i}<button class="anchor-choice" class:chosen={state.anchor.x === choice.x && state.anchor.y === choice.y} role="radio" aria-checked={state.anchor.x === choice.x && state.anchor.y === choice.y} tabindex={state.anchor.x === choice.x && state.anchor.y === choice.y ? 0 : -1} aria-label={choice.label} title={choice.label} disabled={arrangeDisabled} on:keydown={(e)=>anchorKey(e,i)} on:click={(e)=>action(e,()=>setArrangementAnchor(choice.x as 0|.5|1,choice.y as 0|.5|1))}>{#if state.topology === "grid"}<span aria-hidden="true">{state.anchor.x === choice.x && state.anchor.y === choice.y ? "●" : "·"}</span>{:else}{choice.label}{/if}</button>{/each}
        </div><p class="status" role="status">{state.status}</p></section>
        <div class="arrange-keys"><span><kbd>A</kbd> row / column</span><span><kbd>G</kbd> grid</span><span><kbd>D</kbd>/<kbd>F</kbd> rows</span></div>
      {/if}
    </div>
    <footer><button disabled={state.mode === "align" && arrangeDisabled} on:click={(e)=>action(e,()=>switchAlignArrange(state!.mode === "align" ? "arrange" : "align"))}><kbd>Space</kbd> {state.mode === "align" ? "Arrange" : "Align"}</button>{#if state.mode === "arrange"}<button class="apply" on:click={()=>closeAlignArrange()}><kbd>↵</kbd> Apply</button>{/if}<button on:click={()=>closeAlignArrange(true)}><kbd>Esc</kbd> {state.mode === "arrange" ? "Cancel" : "Close"}</button></footer>
  </div>
{/if}

<style>
  .align-arrange-panel { position:fixed;z-index:80;width:324px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);display:flex;flex-direction:column;visibility:hidden;background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-ui,4px);box-shadow:var(--elev-3);color:var(--c-tx);font:12px var(--font-ui);outline:none; }
  .align-arrange-panel.placed { visibility:visible; }
  header { display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid var(--c-line);background:var(--c-bg-raised); }
  h2 { margin:0;font:600 17px var(--font-serif);color:var(--c-tx-hi);white-space:nowrap; }
  .count { margin-left:auto;color:var(--c-tx-muted);font:10px var(--font-mono);white-space:nowrap; }
  button { border:1px solid var(--c-line);border-radius:var(--r-ui,3px);background:var(--c-bg-raised);color:var(--c-tx);font:12px var(--font-ui);cursor:var(--cursor-cross-hover); }
  button:hover:not(:disabled) { background:var(--c-bg);border-color:var(--c-line-strong);color:var(--c-tx-hi); }
  button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline:2px solid var(--c-accent);outline-offset:2px; }
  button:disabled { opacity:.36;cursor:var(--cursor-cross); }
  .close { width:23px;height:23px;padding:0;border-color:transparent;background:none;font-size:20px;color:var(--c-tx-muted); }
  nav { display:flex;border-bottom:1px solid var(--c-line);padding:5px 9px;gap:4px; }
  nav button { flex:1;padding:5px;border:0;background:none;color:var(--c-tx-muted); }
  nav button.current { color:var(--c-tx-hi);background:var(--c-bg-raised);box-shadow:inset 0 -2px var(--c-accent); }
  .body { padding:12px;overflow:auto;min-height:0; }
  .select-row { display:flex;align-items:center;gap:9px;margin:4px 0 8px;font-size:11px;color:var(--c-tx-muted); }
  .select-row > span { flex:0 0 62px; }
  select { min-width:0;flex:1;height:27px;padding:0 6px;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line);border-radius:var(--r-ui,3px);font:11px var(--font-ui); }
  .align-pad { display:grid;grid-template:repeat(3,61px)/repeat(3,1fr);gap:5px;max-width:248px;margin:14px auto 9px; }
  .edge { position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:3px;font-size:10.5px; }
  .edge svg { width:28px;height:28px; }
  .edge kbd { position:absolute;right:5px;top:4px; }
  .top { grid-area:1/2; }.left { grid-area:2/1; }.right { grid-area:2/3; }.bottom { grid-area:3/2; }
  .pad-center { grid-area:2/2;display:grid;place-items:center;font:25px var(--font-mono);color:var(--c-line-strong); }
  svg { fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0; }
  kbd { color:var(--c-accent-bright,var(--c-accent));font:10px var(--font-mono); }
  .centers,.spine-buttons,.two { display:flex;gap:7px; }
  .centers button { display:flex;align-items:center;gap:6px;flex:1;padding:7px 5px;font-size:11px; }
  .centers svg { width:23px;height:23px; }.centers kbd { margin-left:auto; }
  section { border-top:1px solid var(--c-line);margin-top:13px;padding-top:12px; }
  h3 { margin:0 0 9px;font:600 12px var(--font-serif);color:var(--c-tx-hi); }
  h3 span { display:block;margin-top:3px;color:var(--c-tx-muted);font:10.5px var(--font-ui);font-weight:400; }
  .spine-buttons button { display:flex;align-items:center;gap:7px;flex:1;padding:8px 5px;font-size:11px; }
  .spine-buttons svg { width:43px;height:29px; }.spine-buttons kbd { margin-left:auto; }
  .spine { stroke:var(--c-success);stroke-width:3; }
  .hint,.notice,.exclusions { font-size:11px;line-height:1.45;color:var(--c-tx-muted);margin:8px 0; }
  .notice { padding:8px;background:var(--c-bg-raised);border-left:2px solid var(--c-accent); }
  .exclusions { font-size:10px; }
  details { margin-top:9px;font-size:11px; } summary { cursor:var(--cursor-cross-hover);color:var(--c-tx-2);padding:3px 0; }
  .plot-choice { margin-top:10px; }.plot-choice strong { display:block;font-size:11px;margin-bottom:5px; }
  .two button { flex:1;padding:6px;font-size:11px; }
  .topologies { display:flex;gap:6px; }.topologies button { flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;font-size:11px; }
  .topologies button.current { border-color:var(--c-accent);color:var(--c-tx-hi); }
  .layout-symbol { height:20px;display:grid;place-items:center;font-size:21px;line-height:1;font-family:var(--font-mono); }
  .shape-row { display:flex;align-items:center;justify-content:space-between;margin:11px 0;color:var(--c-tx-muted);font-size:11px; }.shape-row strong { margin-left:7px;color:var(--c-tx);font:12px var(--font-mono); }
  .stepper { display:flex;align-items:center;gap:7px; }.stepper button { width:25px;height:24px;font-size:17px; }
  .gap-fields { display:flex;gap:12px; }.gap-fields > div { flex:1;min-width:0; }
  .link-gaps { display:flex;align-items:center;gap:5px;margin-top:10px;color:var(--c-tx-muted);font-size:10.5px; }.link-gaps input { accent-color:var(--c-accent); }
  .anchor-options { display:flex;gap:5px; }.anchor-choice { flex:1;padding:7px 8px;font-size:11px; }.anchor-choice.chosen { border-color:var(--c-accent);background:var(--c-bg);color:var(--c-accent-bright,var(--c-accent)); }
  .anchor-options.grid { display:grid;grid-template-columns:repeat(3,33px);gap:4px;margin:12px auto;width:max-content; }.grid .anchor-choice { width:33px;height:30px;padding:0;font-size:20px; }
  .status { font:10.5px var(--font-ui);color:var(--c-tx-muted);text-align:center;margin:11px 0 0; }
  .arrange-keys { display:flex;justify-content:center;gap:12px;color:var(--c-tx-muted);font-size:10px;margin-top:13px; }
  footer { display:flex;align-items:center;gap:9px;padding:9px 10px;border-top:1px solid var(--c-line);background:var(--c-bg-raised); }
  footer button { padding:2px 0;background:none;border:0;font:11px var(--font-serif);color:var(--c-tx-muted); }footer button:last-child { margin-left:auto; }footer kbd { margin-right:3px; }footer .apply { color:var(--c-tx-hi); }
</style>
