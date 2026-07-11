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
};
