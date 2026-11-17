<script lang="ts">
  /** Align & Arrange (A / Alt+T): the layout tool surface beside the selection.
   *
   * One vocabulary throughout, the property menu's: a key cap, a glyph, a word. Two panes stay
   * visible; exactly one owns the keyboard (its caps light up in the tool colour) and the other
   * carries the Space cap that would hand the keys over. Nothing here plans or moves anything:
   * interact/alignArrange.ts owns the visit, the previews and every model write. */
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
    canMatchPlotAreas, matchSelectedPlotAreas,
  } from "./interact/alignArrange";
  import type { AlignKind } from "./geometry";

  export let active = true;

  type Hover = Parameters<typeof setAlignArrangeHover>[0];
  type Topology = "row" | "column" | "grid";
  type Target = "selection" | "reference" | "figure";
  /** A 16 × 16 glyph: `ink` is the objects (filled), `rule` the line they meet (the tool colour). */
  interface Glyph { ink: string; rule?: string }

  // Column one runs along x (left · center · right), column two along y (top · middle · bottom):
  // the grid fills by column, so each axis reads top to bottom under one heading-less column.
  const ALIGNMENTS: { kind: AlignKind; key: string; label: string; name: string; glyph: Glyph }[] = [
    { kind: "left", key: "A", label: "Left", name: "left", glyph: { rule: "M2.5 2v12", ink: "M5 4h8v3H5zM5 9h5v3H5z" } },
    { kind: "centerH", key: "H", label: "Center", name: "x centers", glyph: { rule: "M8 2v12", ink: "M3 4h10v3H3zM5 9h6v3H5z" } },
    { kind: "right", key: "D", label: "Right", name: "right", glyph: { rule: "M13.5 2v12", ink: "M3 4h8v3H3zM6 9h5v3H6z" } },
    { kind: "top", key: "W", label: "Top", name: "top", glyph: { rule: "M2 2.5h12", ink: "M4 5h3v8H4zM9 5h3v5H9z" } },
    { kind: "centerV", key: "V", label: "Middle", name: "y centers", glyph: { rule: "M2 8h12", ink: "M4 3h3v10H4zM9 5h3v6H9z" } },
    { kind: "bottom", key: "S", label: "Bottom", name: "bottom", glyph: { rule: "M2 13.5h12", ink: "M4 3h3v8H4zM9 6h3v5H9z" } },
  ];
  const DISTRIBUTIONS: { axis: "h" | "v"; key: string; label: string; aria: string; title: string; glyph: Glyph }[] = [
    { axis: "h", key: "⇧H", label: "Horizontal", aria: "Distribute horizontal spacing", title: "Even horizontal spacing; the outermost objects stay put (Shift+H)", glyph: { ink: "M2 4h2.5v8H2zM6.75 4h2.5v8h-2.5zM11.5 4H14v8h-2.5z" } },
    { axis: "v", key: "⇧V", label: "Vertical", aria: "Distribute vertical spacing", title: "Even vertical spacing; the outermost objects stay put (Shift+V)", glyph: { ink: "M4 2h8v2.5H4zM4 6.75h8v2.5H4zM4 11.5h8V14H4z" } },
  ];
  const SPINES: { axis: "x" | "y"; key: string; label: string; hover: Hover; glyph: Glyph }[] = [
    { axis: "x", key: "X", label: "X spines", hover: "plot-x", glyph: { rule: "M1.5 12.5h13", ink: "M2 3h1.2v9.5H2zM9 6h1.2v6.5H9z" } },
    { axis: "y", key: "Y", label: "Y spines", hover: "plot-y", glyph: { rule: "M3.5 1.5v13", ink: "M3.5 6h9.5v1.2H3.5zM3.5 13h6.5v1.2H3.5z" } },
  ];
  const TOPOLOGIES: { id: Topology; key: string; label: string; glyph: Glyph }[] = [
    { id: "row", key: "R", label: "Row", glyph: { ink: "M1.5 6h3.5v4H1.5zM6.25 6h3.5v4h-3.5zM11 6h3.5v4H11z" } },
    { id: "column", key: "C", label: "Column", glyph: { ink: "M6 1.5h4V5H6zM6 6.25h4v3.5H6zM6 11h4v3.5H6z" } },
    { id: "grid", key: "G", label: "Grid", glyph: { ink: "M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" } },
  ];
  const TARGETS: { id: Target; label: string; title: string }[] = [
    { id: "selection", label: "Selection", title: "Align to the bounds of the selection" },
    { id: "reference", label: "Object", title: "Align to one object, which stays put" },
    { id: "figure", label: "Figure", title: "Align to the figure frame" },
  ];
  const MATCHES = ["height", "width", "both"] as const;
  const TARGET_PHRASE: Record<Target, string> = { selection: "the selection", reference: "the reference object", figure: "the figure" };
  const HOVER_PHRASE: Partial<Record<NonNullable<Hover>, string>> = {
    left: "Left edges", centerH: "Centers, side by side", right: "Right edges",
    top: "Top edges", centerV: "Middles, one above another", bottom: "Bottom edges",
    "plot-x": "Horizontal axes on one line", "plot-y": "Vertical axes on one line",
  };

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
  $: aligning = state?.mode === "align";
  $: anchorName = !state ? "" : state.anchor.x === .5 && state.anchor.y === .5 ? "Center"
    : `${state.anchor.y === 0 ? "Top" : state.anchor.y === 1 ? "Bottom" : "Middle"} ${state.anchor.x === 0 ? "left" : state.anchor.x === 1 ? "right" : "center"}`;
  $: hint = !state ? "" : aligning
    ? (state.hover && HOVER_PHRASE[state.hover]
      ? (state.hover === "plot-x" || state.hover === "plot-y" ? HOVER_PHRASE[state.hover]! : `${HOVER_PHRASE[state.hover]} → ${TARGET_PHRASE[state.alignTarget]}`)
      : "")
    : (state.status || `Existing ${state.topology}`);

  $: if (state && (!lifecycle.open || lifecycle.id !== state.id)) {
    lifecycle.open = true; lifecycle.id = state.id;
    void place(state.id);
  }
  $: if (!state && lifecycle.open) {
    if (!active && $alignArrange?.id === lifecycle.id) closeAlignArrange();
    lifecycle.open = false; placed = false;
    observer?.disconnect(); observer = null;
  }
  // A plot whose spine cannot be chosen automatically opens its choices once, unasked.
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
  /** A pointer click returns focus to the surface, so the next key is the tool's and not the button's. */
  function action(e: MouseEvent, run: () => void) { run(); if (e.detail > 0) focusSurface(); }
  function activate(mode: "align" | "arrange") { if (state?.mode !== mode) switchAlignArrange(mode); }
  function align(e: MouseEvent, kind: AlignKind) { action(e, () => { activate("align"); alignSelection(kind); }); }
  function hover(kind: Hover) { setAlignArrangeHover(kind); }
  const fieldOwner = (axis: "x" | "y") => ({
    begin: (kind?: "typing" | "wheel" | "scrub") => { activate("arrange"); beginArrangementField(axis, kind); },
    interaction: (kind: "typing" | "wheel" | "scrub" | null) => setArrangementFieldInteraction(axis, kind),
    owns: () => ownsArrangementField(axis),
    preview: (v: number | undefined) => { if (v !== undefined) setArrangementGap(axis, v); },
    accept: acceptArrangementField, cancel: cancelArrangementField, validity: setArrangementFieldValidity,
  });
  onDestroy(() => { observer?.disconnect(); if (lifecycle.open && $alignArrange?.id === lifecycle.id) closeAlignArrange(); });
</script>

<svelte:window on:pointermove={(e) => { pointer.x = e.clientX; pointer.y = e.clientY; }} on:pointerdown|capture={outside} on:resize={reposition} />

{#if state}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
  <div class="align-arrange-panel" class:placed bind:this={panel} tabindex="-1" role="dialog" aria-label={aligning ? "Flux Align" : "Flux Arrange"} data-command-scope="align-arrange" data-mode={state.mode} style={`left:${position.x}px;top:${position.y}px;`} on:pointerdown|stopPropagation>
    <header>
      <span class="mark"><Logomark size={14} /></span>
      <span class="vsep"></span>
      <h2>Align &amp; Arrange</h2>
      <span class="count">{state.count} {state.count === 1 ? "object" : "objects"}</span>
      <button class="close" aria-label="Close alignment tool" title="Close and keep changes" on:click={() => closeAlignArrange()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </header>
    {#if state.blockedReason}<p class="notice" role="status">{state.blockedReason}</p>{/if}
    {#if state.excludedCount}<p class="notice quiet">{state.excludedCount} locked or hidden {state.excludedCount === 1 ? "object excluded" : "objects excluded"}</p>{/if}

    <div class="body">
      <!-- Both panes stay visible; a press inside one hands it the keyboard before it acts. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tool-pane align-pane" class:active={aligning} on:pointerdown|capture={() => activate("align")} on:focusin={() => activate("align")}>
        <button class="pane-title" aria-pressed={aligning} title={aligning ? "The keyboard drives Align" : "Use Align (Space)"} on:click={(e) => action(e, () => activate("align"))}>
          <span>Align</span>{#if !aligning}<kbd>Space</kbd>{/if}
        </button>
        <div class="pane-content">
          <div class="target">
            <span class="to">to</span>
            <div class="segments" role="radiogroup" aria-label="Align to">
              {#each TARGETS as target}
                <button role="radio" aria-checked={state.alignTarget === target.id} class:chosen={state.alignTarget === target.id} data-align-target={target.id} title={target.title} disabled={blocked || state.count === 0 || (target.id !== "figure" && state.count < 2)} on:click={(e) => action(e, () => setAlignTarget(target.id))}>{target.label}</button>
              {/each}
            </div>
          </div>
          {#if state.alignTarget === "reference"}
            <label class="select-row"><span>Object</span><select aria-label="Alignment reference object" value={state.referenceId} on:change={(e) => setAlignReference(e.currentTarget.value)}>{#each state.units as unit}<option value={unit.id}>{unit.label}</option>{/each}</select></label>
          {/if}
          <div class="cells by-column" aria-label="Align object edges and centers">
            {#each ALIGNMENTS as item}
              <button class={`cell alignment ${item.kind}`} disabled={blocked || !state.count} aria-label={`Align ${item.name}`} title={`Align ${item.name} (${item.key})`} on:click={(e) => align(e, item.kind)} on:mouseenter={() => hover(item.kind)} on:mouseleave={() => hover(null)} on:focus={() => hover(item.kind)} on:blur={() => hover(null)}>
                <kbd>{item.key}</kbd>
                <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path class="ink" d={item.glyph.ink} /><path class="rule" d={item.glyph.rule} /></svg>
                <span>{item.label}</span>
              </button>
            {/each}
          </div>

          <section class="distribution">
            <h3>Distribute</h3>
            <div class="cells">
              {#each DISTRIBUTIONS as item}
                <button class="cell" disabled={blocked || state.count < 3} aria-label={item.aria} title={item.title} on:click={(e) => action(e, () => { activate("align"); distributeSelection(item.axis); })}>
                  <kbd>{item.key}</kbd>
                  <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path class="ink" d={item.glyph.ink} /></svg>
                  <span>{item.label}</span>
                </button>
              {/each}
            </div>
          </section>

          {#if state.plot}
            <section class="plots-section">
              <h3>Plots</h3>
              <div class="cells spine-buttons">
                {#each SPINES as item}
                  {@const reason = item.axis === "x" ? state.plot.reasonX : state.plot.reasonY}
                  <button class="cell" disabled={blocked || state.plot.loading || !!reason} title={reason ?? `Align ${item.axis === "x" ? "horizontal X" : "vertical Y"} spines (${item.key})`} on:click={(e) => action(e, () => alignPlotSpines(item.axis))} on:mouseenter={() => hover(item.hover)} on:mouseleave={() => hover(null)} on:focus={() => hover(item.hover)} on:blur={() => hover(null)}>
                    <kbd>{item.key}</kbd>
                    <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path class="ink" d={item.glyph.ink} /><path class="rule" d={item.glyph.rule} /></svg>
                    <span>{item.label}</span>
                  </button>
                {/each}
              </div>
              {#if state.plot.units.length}
                <label class="select-row"><span>Reference</span><select aria-label="Plot alignment reference" value={state.plot.referenceId} on:change={(e) => setPlotAlignReference(e.currentTarget.value)}>{#each state.plot.units as unit}<option value={unit.id}>{unit.label}</option>{/each}</select></label>
              {/if}
              <div class="match">
                <span class="to">Match area</span>
                <div class="segments match-buttons" data-match-plot-area>
                  {#each MATCHES as dimension}
                    <button disabled={!matchEnabled} aria-label={`Match plot area ${dimension}`} title={`Give the selected plots the reference plot's data-area ${dimension === "both" ? "size" : dimension}`} on:click={(e) => action(e, () => matchSelectedPlotAreas(dimension))}>{dimension[0].toUpperCase() + dimension.slice(1)}</button>
                  {/each}
                </div>
              </div>
              {#if state.matchPanels}<p class="hint" data-match-panel-scope>Matching the selected X-ray panels; other plots use their full data area.</p>{/if}
              {#if state.plot.loading}<p class="hint" role="status">Reading selected plot spines…</p>
              {:else}
                {#if state.plot.reasonX}<p class="hint">X: {state.plot.reasonX}</p>{/if}
                {#if state.plot.reasonY && state.plot.reasonY !== state.plot.reasonX}<p class="hint">Y: {state.plot.reasonY}</p>{/if}
                {#if state.plot.units.some(u => u.explicitChoice || u.optionsX.length > 1 || u.optionsY.length > 1 || (!u.choiceX && u.optionsX.length > 0) || (!u.choiceY && u.optionsY.length > 0))}
                  <details bind:open={plotDetailsOpen}>
                    <summary>Plot, panel &amp; spine choices</summary>
                    {#each state.plot.units as unit}
                      <div class="plot-choice">
                        <strong>{unit.label}</strong>
                        {#each ["x", "y"] as axis}
                          <label class="select-row"><span>{axis.toUpperCase()} spine</span><select aria-label={`${unit.label} ${axis.toUpperCase()} spine`} value={axis === "x" ? unit.choiceX : unit.choiceY} on:change={(e) => setPlotAlignChoice(unit.id, axis as "x" | "y", e.currentTarget.value)}><option value="">Choose a spine</option>{#each axis === "x" ? unit.optionsX : unit.optionsY as option}<option value={option.value}>{option.label}</option>{/each}</select></label>
                        {/each}
                      </div>
                    {/each}
                  </details>
                {/if}
              {/if}
            </section>
          {/if}
        </div>
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tool-pane arrange-pane" class:active={!aligning} on:pointerdown|capture={() => activate("arrange")} on:focusin={() => activate("arrange")} on:wheel|capture={(e) => { if (e.target instanceof Element && e.target.closest(".nf input")) activate("arrange"); }}>
        <button class="pane-title" aria-pressed={!aligning} disabled={arrangeDisabled} title={aligning ? "Use Arrange (Space)" : "The keyboard drives Arrange"} on:click={(e) => action(e, () => activate("arrange"))}>
          <span>Arrange</span>{#if aligning && !arrangeDisabled}<kbd>Space</kbd>{/if}
        </button>
        <div class="pane-content">
          <div class="cells topologies" role="radiogroup" aria-label="Arrangement layout">
            {#each TOPOLOGIES as layout}
              <button class="cell" role="radio" class:chosen={state.topology === layout.id} aria-checked={state.topology === layout.id} disabled={arrangeDisabled} title={`Reflow as ${layout.label.toLowerCase()} (${layout.key})`} on:click={(e) => action(e, () => reflowArrangement(layout.id))}>
                <kbd>{layout.key}</kbd>
                <svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path class="ink" d={layout.glyph.ink} /></svg>
                <span>{layout.label}</span>
              </button>
            {/each}
            <!-- Rows × columns sits beside Grid: − and + walk every shape from one row to one column. -->
            <div class="shape-row">
              <span class="shape" title="Rows × columns"><strong>{state.rows}</strong><i>×</i><strong>{state.cols}</strong></span>
              <div class="stepper" role="group" aria-label="Rows">
                <button disabled={arrangeDisabled || state.rows <= 1} aria-label="Fewer rows" title="Fewer rows (− or F)" on:click={(e) => action(e, () => stepArrangementRows(-1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7" /></svg></button>
                <button disabled={arrangeDisabled || state.rows >= state.count} aria-label="More rows" title="More rows (+ or D)" on:click={(e) => action(e, () => stepArrangementRows(1))}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7M8 4.5v7" /></svg></button>
              </div>
            </div>
          </div>

          <section class="spacing">
            <h3>Spacing</h3>
            <div class="gap-fields">
              {#if state.topology !== "column"}
                <div class="gap" on:focusin={() => hover("gap-x")} on:focusout={() => hover(null)}><NumberField label={state.topology === "grid" ? "Column gap" : "Gap"} value={state.gapX} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("x")} title="Horizontal spacing in canvas pixels; negative values overlap" /></div>
              {/if}
              {#if state.topology === "grid"}
                <button class="link-gaps" class:chosen={state.linkedGaps} role="switch" aria-checked={state.linkedGaps} aria-label="Link gaps" title={state.linkedGaps ? "Gaps are linked: one value for both" : "Link the gaps: one value for both"} disabled={arrangeDisabled} on:click={(e) => action(e, () => setArrangementLinked(!state!.linkedGaps))}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 9.5l3-3M7 5l1.2-1.2a2.6 2.6 0 013.7 3.7L10.7 8.7M9 11l-1.2 1.2a2.6 2.6 0 01-3.7-3.7L5.3 7.3" /></svg>
                </button>
              {/if}
              {#if state.topology !== "row"}
                <div class="gap" on:focusin={() => hover("gap-y")} on:focusout={() => hover(null)}><NumberField label={state.topology === "grid" ? "Row gap" : "Gap"} value={state.gapY} displayPrecision={3} live disabled={arrangeDisabled} externalOwner={fieldOwner("y")} title="Vertical spacing in canvas pixels; negative values overlap" /></div>
              {/if}
            </div>
          </section>

          <section class="anchor-section">
            <h3>Keep fixed</h3>
            <div class="anchor-row" class:grid-anchor={state.topology === "grid"}>
              <ArrangementAnchorPicker topology={state.topology} anchor={state.anchor} disabled={arrangeDisabled} onchange={setArrangementAnchor} />
              {#if state.topology === "grid"}<span class="anchor-name">{anchorName}</span>{/if}
            </div>
          </section>
        </div>
      </div>
    </div>

    <footer>
      <span class="status-line" role="status">{hint}</span>
      <button class="secondary" on:click={() => closeAlignArrange(true)}><kbd>esc</kbd>{aligning ? "Close" : "Cancel"}</button>
      {#if !aligning}<button class="apply" on:click={() => closeAlignArrange()}><kbd>↵</kbd>Apply</button>{/if}
    </footer>
  </div>
{/if}

<style>
  /* The property menu's sibling: serif words, mono eyebrows and values, global key caps, 2 px
     radii, hairlines, tint + inset rail for what is chosen. The tool's own colour
     (--c-layout-gap, the canvas gutters' magenta) marks only STATE: the pane that owns the keys,
     the chosen layout, the fixed point, the line an alignment meets. */
  .align-arrange-panel {
    --tool: var(--c-layout-gap);
    --tool-tint: var(--c-layout-gap-tint);
    position: fixed; z-index: 80; width: 548px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
    display: flex; flex-direction: column; visibility: hidden; overflow: hidden;
    background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel, 3px); box-shadow: var(--elev-2);
    color: var(--c-tx); font: 12.5px var(--font-serif); outline: none;
  }
  .align-arrange-panel.placed { visibility: visible; animation: aa-in 70ms var(--ease-standard, ease-out) 1; }
  @keyframes aa-in { from { opacity: 0; } to { opacity: 1; } }

  header { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px 0 10px; flex-shrink: 0; background: var(--c-bg-raised); border-bottom: 1px solid var(--c-line); }
  .mark { display: inline-flex; width: 14px; height: 14px; flex-shrink: 0; }
  .vsep { width: 1px; height: 14px; background: var(--c-line-strong); flex-shrink: 0; }
  h2 { margin: 0; font: 600 13px var(--font-serif); color: var(--c-tx-hi); white-space: nowrap; }
  .count { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); font: 11px var(--font-mono); font-variant-numeric: tabular-nums; }

  button { margin: 0; border: 1px solid transparent; border-radius: var(--r-ui, 2px); background: transparent; color: var(--c-tx-2); font: inherit; cursor: var(--cursor-cross-hover); transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear; }
  button:disabled { opacity: .38; cursor: var(--cursor-cross); }
  button:focus-visible, select:focus-visible, summary:focus-visible { outline: 1px solid var(--tool); outline-offset: 1px; }
  svg { display: block; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; }
  .close { display: grid; place-items: center; width: 22px; height: 22px; padding: 0; color: var(--c-tx-muted); }
  .close:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .close svg { width: 12px; height: 12px; stroke-width: 1.5; }

  .notice { margin: 0; padding: 6px 10px; border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); color: var(--c-tx-2); font-size: 11.5px; line-height: 1.45; }
  .notice.quiet { color: var(--c-tx-muted); }

  .body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); overflow: auto; min-height: 0; }
  .tool-pane { min-width: 0; }
  .arrange-pane { border-left: 1px solid var(--c-line); }

  /* Pane head: a mono eyebrow. The live pane wears the tool colour and its rail; the other one
     shows the Space cap that would bring the keys over. */
  .pane-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; height: 26px; padding: 0 10px; border: 0; border-bottom: 1px solid var(--c-line); border-radius: 0; color: var(--c-tx-muted); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; text-align: left; }
  .pane-title:hover:not(:disabled) { color: var(--c-tx-hi); }
  .pane-title kbd { color: var(--c-tx-muted); text-transform: none; letter-spacing: 0; }
  .active .pane-title, .active .pane-title:hover { color: var(--tool); box-shadow: inset 0 -2px 0 var(--tool); }
  .pane-content { padding: 9px 10px 11px; }

  /* Key caps (the box is global, app.css). Lit where the keyboard is, faint where it is not. */
  kbd { flex-shrink: 0; color: var(--c-tx-faint); }
  .active kbd { color: var(--tool); }

  /* Cells: cap · glyph · word, two to a row. Never a cap ON a word: each has its own column. */
  .cells { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; }
  .cells.by-column { grid-template-rows: repeat(3, auto); grid-auto-flow: column; }
  .cell { display: grid; grid-template-columns: auto 16px minmax(0, 1fr); align-items: center; column-gap: 7px; height: 26px; padding: 0 6px 0 5px; border-color: var(--c-line); background: var(--c-bg); text-align: left; }
  .cell > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell:hover:not(:disabled) { border-color: var(--c-line-strong); background: var(--c-surface-2); color: var(--c-tx-hi); }
  .cell:active:not(:disabled) { background: var(--tool-tint); border-color: var(--tool); }
  .glyph { width: 16px; height: 16px; }
  .ink { fill: currentColor; stroke: none; opacity: .82; }
  .rule { stroke: var(--c-tx-muted); stroke-width: 1.25; }
  .active .rule, .cell:hover:not(:disabled) .rule { stroke: var(--tool); }
  .cell.chosen { background: var(--tool-tint); border-color: color-mix(in oklab, var(--tool) 55%, transparent); box-shadow: inset 2px 0 0 var(--tool); color: var(--c-tx-hi); }
  .cell.chosen .ink { fill: var(--tool); opacity: 1; }

  /* "to …": what an alignment measures against. */
  .target, .match { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .match { margin: 8px 0 0; }
  .to { flex: 0 0 auto; color: var(--c-tx-muted); font-size: 12px; }
  .segments { display: flex; flex: 1; min-width: 0; padding: 1px; gap: 1px; border: 1px solid var(--c-line); border-radius: var(--r-ui, 2px); background: var(--c-bg); }
  .segments button { flex: 1; min-width: 0; height: 20px; padding: 0 4px; border: 0; color: var(--c-tx-muted); font: 11.5px var(--font-serif); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .segments button:hover:not(:disabled) { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .segments button.chosen { background: var(--tool-tint); color: var(--c-tx-hi); box-shadow: inset 0 -1px 0 var(--tool); }
  .select-row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; color: var(--c-tx-muted); font-size: 12px; }
  .select-row > span { flex: 0 0 auto; }
  select { min-width: 0; flex: 1; height: 22px; padding: 0 4px; background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui, 2px); font: 11.5px var(--font-ui); }
  select:hover:not(:disabled) { border-color: var(--c-tx-muted); }

  section { margin-top: 11px; }
  h3 { margin: 0 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--c-line); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--c-tx-muted); }
  .hint { margin: 7px 0 0; color: var(--c-tx-muted); font-size: 11.5px; line-height: 1.45; }
  .plots-section .select-row { margin: 8px 0 0; }
  details { margin-top: 8px; font-size: 11.5px; }
  summary { padding: 2px 0; color: var(--c-tx-2); cursor: var(--cursor-cross-hover); }
  summary:hover { color: var(--c-tx-hi); }
  .plot-choice { margin-top: 8px; }
  .plot-choice strong { display: block; margin-bottom: 5px; color: var(--c-tx-hi); font-weight: 600; }

  /* Arrange. Row and Column share a line; Grid sits beside its own shape. */
  .shape-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 26px; padding-left: 8px; }
  .shape { display: inline-flex; align-items: baseline; gap: 5px; color: var(--c-tx-hi); font: 600 12px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .shape strong { font-weight: 600; }
  .shape i { font-style: normal; font-weight: 400; color: var(--c-tx-faint); }
  .stepper { display: inline-flex; flex-shrink: 0; border: 1px solid var(--c-line); border-radius: var(--r-ui, 2px); background: var(--c-bg); }
  .stepper button { display: grid; place-items: center; width: 22px; height: 20px; padding: 0; border: 0; border-radius: 0; }
  .stepper button + button { border-left: 1px solid var(--c-line); }
  .stepper button:hover:not(:disabled) { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .stepper svg { width: 12px; height: 12px; stroke-width: 1.5; }

  .gap-fields { display: flex; align-items: flex-end; gap: 4px; }
  .gap { flex: 1; min-width: 0; }
  .gap-fields :global(.nf) { margin: 0; }
  .gap-fields :global(.nf .lb) { font: 12px var(--font-serif); color: var(--c-tx-muted); }
  .gap-fields :global(.nf input) { height: 22px; font: 12px var(--font-mono); }
  .link-gaps { display: grid; place-items: center; flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border-color: var(--c-line); background: var(--c-bg); color: var(--c-tx-muted); }
  .link-gaps:hover:not(:disabled) { border-color: var(--c-line-strong); color: var(--c-tx-hi); }
  .link-gaps.chosen { background: var(--tool-tint); border-color: color-mix(in oklab, var(--tool) 55%, transparent); color: var(--tool); }
  .link-gaps svg { width: 14px; height: 14px; }
  /* A grid's nine points: the miniature frame, and the chosen point in words beside it. */
  .anchor-row.grid-anchor { display: flex; align-items: center; gap: 6px; }
  .anchor-name { color: var(--c-tx-2); }

  /* Foot: what is under the pointer or what Arrange just did; then the ways out. */
  footer { display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px 0 10px; flex-shrink: 0; border-top: 1px solid var(--c-line); background: var(--c-bg-raised); font: 11px var(--font-ui); }
  .status-line { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); }
  footer button { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px 0 5px; color: var(--c-tx-muted); font: 11px var(--font-ui); }
  footer button:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  footer kbd { color: var(--c-tx-muted); }
  footer .apply { background: var(--tool-tint); border-color: color-mix(in oklab, var(--tool) 55%, transparent); color: var(--c-tx-hi); }
  footer .apply:hover { background: color-mix(in oklab, var(--tool) 26%, transparent); border-color: var(--tool); }
  footer .apply kbd { color: var(--tool); }

  /* Narrow windows: the panes stack, everything else is unchanged. */
  @media (max-width: 580px) {
    .align-arrange-panel { width: 290px; }
    .body { grid-template-columns: minmax(0, 1fr); }
    .arrange-pane { border-left: 0; border-top: 1px solid var(--c-line); }
  }
  @media (prefers-reduced-motion: reduce) {
    .align-arrange-panel.placed { animation: none; }
    button { transition: none; }
  }
</style>
