// WS-1 (fortify plan): tiny always-on recompute counters for the figure
// editor's hot derives. Verify gates assert structural behavior with these
// (e.g. "a bridge edit while the Figure pane is hidden performs zero culling/
// row recomputes"). Incrementing a number is free; reachable headless via
// window.__flux.perf (devHandle).

export const perfCounters = {
  /** Canvas per-figure visibleEls recomputations (cache misses). */
  visRecomputes: 0,
  /** Canvas effState full rebuilds (cache misses). */
  effRecomputes: 0,
  /** Sidebar layer-row derives (cache misses). */
  rowsRecomputes: 0,
  /** Scene elements passed on to their renderer by ElementSlot (mounts and
   *  changed elements; an unchanged element costs a content compare only). */
  elementRenders: 0,
  /** ElementSlot content checks: every time a mounted element is re-fed its props
   *  (a re-rendered figure {#each}), changed or not. Zero for a sidebar drag. */
  slotChecks: 0,
  /** Slide Become picker: pointer moves its hover handled, the ms they cost in
   *  total, the worst one, and how many resolved a NEW unit (re-measured). */
  pickHoverMoves: 0,
  pickHoverMs: 0,
  pickHoverWorstMs: 0,
  pickHoverChanges: 0,
};
