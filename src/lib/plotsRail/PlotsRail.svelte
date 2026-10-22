<script lang="ts">
  // The Plots view of the Figure editor's left rail: the Gallery on top, the Dissections pane
  // below (master over detail), a draggable splitter between them. Drag within SNAP px of an
  // edge to collapse a pane; double-click the splitter to reset. Both panes never collapse
  // together; the layout never moves on its own (an empty dissection does not resize anything).
  //
  // It also feeds the Dissections pane's FOCUS from the canvas: a selection that resolves to a
  // plot, and every press on the canvas (re-clicking the already-selected plot changes no
  // selection store, yet must take the focus back from a gallery click).
  import { untrack } from "svelte";
  import { get } from "svelte/store";
  import GalleryPane from "./GalleryPane.svelte";
  import DissectionsPane from "./DissectionsPane.svelte";
  import { figureLayout, FIGURE_LAYOUT_DEFAULTS } from "../figureLayoutStore";
  import { pointerDrag } from "../ui/pointerDrag";
  import { resolvePlotElement, offerElement, resetFocus } from "./focusPlot";
  import { plotsRailFocusRequest, railFocusPending } from "./railState";
  import { PLOTS_RAIL_SCOPE } from "./keyScope";
  import { project, selection, partSelection, embeddedProjectRoot, projectDir } from "../store";
  import type { HitBridgeHolder } from "../interact/canvasHitBridge";

  let { active = true, hitBridge = null, refreshKey = 0 }: { active?: boolean; hitBridge?: HitBridgeHolder | null; refreshKey?: number } = $props();

  const SNAP = 24;
  const MIN_PANE = 96;
  let body = $state<HTMLDivElement>();
  let bodyH = $state(0);
  const root = $derived($embeddedProjectRoot || $projectDir || "");

  const layout = $derived($figureLayout);
  const galleryCollapsed = $derived(layout.galleryCollapsed);
  const dissectCollapsed = $derived(layout.dissectCollapsed);

  $effect(() => {
    const el = body;
    if (!el) return;
    const ro = new ResizeObserver(() => { bodyH = el.clientHeight; });
    ro.observe(el);
    bodyH = el.clientHeight;
    return () => ro.disconnect();
  });
  // Gallery height: the split fraction, clamped so both panes keep MIN_PANE; on a window too
  // short for both, Dissections gives way first.
  const galleryH = $derived.by(() => {
    if (galleryCollapsed) return 22;
    if (dissectCollapsed) return Math.max(0, bodyH - 28 - 5);
    const avail = bodyH - 5;
    if (avail < MIN_PANE * 2) return Math.max(0, avail - 28);
    return Math.round(Math.min(avail - MIN_PANE, Math.max(MIN_PANE, avail * layout.plotsSplit)));
  });

  let cancelDrag: (() => void) | null = null;
  function startSplit(e: PointerEvent) {
    if (e.button !== 0 || !body) return;
    const original = { ...get(figureLayout) };
    const rect = body.getBoundingClientRect();
    cancelDrag = pointerDrag(e, (ev) => {
      const y = ev.clientY - rect.top;
      if (y < SNAP) figureLayout.update((l) => ({ ...l, galleryCollapsed: true, dissectCollapsed: false }));
      else if (y > rect.height - SNAP) figureLayout.update((l) => ({ ...l, dissectCollapsed: true, galleryCollapsed: false }));
      else figureLayout.update((l) => ({ ...l, galleryCollapsed: false, dissectCollapsed: false, plotsSplit: Math.min(0.95, Math.max(0.05, y / Math.max(1, rect.height - 5))) }));
    }, () => figureLayout.set(original), () => { cancelDrag = null; });
  }
  $effect(() => () => cancelDrag?.());
  function resetSplit() {
    figureLayout.update((l) => ({ ...l, plotsSplit: FIGURE_LAYOUT_DEFAULTS.plotsSplit, galleryCollapsed: false, dissectCollapsed: false }));
  }
  function showDissections() {
    if (dissectCollapsed) figureLayout.update((l) => ({ ...l, dissectCollapsed: false }));
  }
  function toggleDissections() {
    figureLayout.update((l) => ({ ...l, dissectCollapsed: !l.dissectCollapsed, galleryCollapsed: l.dissectCollapsed ? l.galleryCollapsed : false }));
  }
  function toggleMaximize() {
    figureLayout.update((l) => ({ ...l, galleryCollapsed: !l.galleryCollapsed, dissectCollapsed: false }));
  }
  // Alt+G must land in a visible search box.
  $effect(() => {
    void $plotsRailFocusRequest;
    untrack(() => { if (railFocusPending() && get(figureLayout).galleryCollapsed) figureLayout.update((l) => ({ ...l, galleryCollapsed: false })); });
  });

  // ------------------------------------------------------------------ canvas → focus
  function offerCanvas() {
    const el = resolvePlotElement(get(project), get(selection), get(partSelection));
    const r = root;
    const assetName = el?.assetId ? get(project).assets.find((a) => a.id === el.assetId)?.name ?? "" : "";
    void offerElement(el, r, assetName, "canvas");
  }
  $effect(() => {
    if (!active) return;
    // Selection-driven (keyboard selection, marquee, Layers clicks) …
    const offSel = selection.subscribe(() => offerCanvas());
    const offPart = partSelection.subscribe(() => offerCanvas());
    // … and press-driven: a press on the canvas re-claims the focus even when it changes no
    // selection (re-clicking the plot that is already selected). After the press is handled.
    const press = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".canvas-wrap")) return;
      setTimeout(offerCanvas, 0);
    };
    window.addEventListener("pointerdown", press, true);
    return () => { offSel(); offPart(); window.removeEventListener("pointerdown", press, true); };
  });
  // A different project: the old focus means nothing here.
  let lastRoot = "";
  $effect(() => { const r = root; if (lastRoot && r !== lastRoot) resetFocus(); lastRoot = r; });
</script>

<div class="plots-rail" data-command-scope={PLOTS_RAIL_SCOPE} data-plots-rail bind:this={body}>
  {#if galleryCollapsed}
    <button class="collapsed-bar" onclick={() => figureLayout.update((l) => ({ ...l, galleryCollapsed: false }))} title="Show the gallery" data-gallery-collapsed>
      <span class="eyebrow">Plots</span><span class="hint">▾ show</span>
    </button>
  {:else}
    <div class="gallery-slot" style:height={`${galleryH}px`}>
      <GalleryPane {active} {hitBridge} {refreshKey} onShowDissections={showDissections} />
    </div>
  {/if}
  {#if !galleryCollapsed && !dissectCollapsed}
    <div class="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize gallery and dissections (double-click resets)" onpointerdown={startSplit} ondblclick={resetSplit} data-plots-splitter></div>
  {/if}
  <DissectionsPane {active} {hitBridge} collapsed={dissectCollapsed} {galleryCollapsed} onCollapse={toggleDissections} onMaximize={toggleMaximize} />
</div>

<style>
  .plots-rail { display: flex; flex-direction: column; flex: 1; min-height: 0; background: var(--c-bg-raised); color: var(--c-tx); font: 12px var(--font-ui); -webkit-font-smoothing: antialiased; }
  .gallery-slot { display: flex; flex-direction: column; flex-shrink: 0; min-height: 0; background: var(--c-bg-raised); }
  .splitter { flex: 0 0 5px; margin: -2px 0; position: relative; z-index: 3; cursor: row-resize; background: transparent; border-top: 1px solid var(--c-line); background-clip: content-box; }
  .splitter:hover { background-color: color-mix(in oklab, var(--c-accent) 35%, transparent); }
  .collapsed-bar { display: flex; align-items: center; gap: 8px; height: 22px; flex-shrink: 0; padding: 0 8px; border: 0; border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); color: var(--c-tx-2); font: inherit; text-align: left; cursor: var(--cursor-cross-hover); }
  .collapsed-bar:hover { color: var(--c-tx-hi); }
  .eyebrow { color: var(--c-tx-muted); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
  .hint { color: var(--c-tx-faint); font: 10.5px var(--font-ui); }
</style>
