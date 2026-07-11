<script lang="ts">
  // WS-1 Fix 6b (fortify plan): hand-rolled fixed-row-height list windowing —
  // no dependency, `ul`/`li` semantics preserved (spacer rows are aria-hidden
  // `li`s), stable keys, ± `overscan` rows beyond the viewport.
  //
  // The SCROLL PARENT is discovered at mount (nearest ancestor with scrollable
  // overflow-y) so the host can keep an outer container as the scroller (the
  // Layers sidebar scrolls the whole <aside>, not the list itself). The window
  // is computed from the parent's scrollTop relative to this list's offset.
  //
  // Scroll anchoring: when `items` changes identity (group expand/collapse,
  // drag reorder), the first visible row's key + pixel offset are captured
  // before the update and restored after — the viewport doesn't jump when rows
  // above it appear/disappear.
  //
  // No ambient timers: geometry is re-read on scroll, resize, and item change
  // only (E43 discipline — nothing runs while the pane is hidden).
  import { beforeUpdate, afterUpdate, onMount } from "svelte";

  type Item = $$Generic;

  export let items: readonly Item[] = [];
  export let rowHeight = 25;
  export let overscan = 10;
  export let getKey: (item: Item) => string;
  /** Optional extra class for the <ul>. */
  export let listClass = "";
  /** Suspend scroll anchoring (set during a drag-reorder: the anchor row may BE
   *  the dragged row, and chasing it shifts scrollTop under the drop targeting). */
  export let anchorSuspended = false;

  let ul: HTMLUListElement;
  let scrollParent: HTMLElement | null = null;
  let viewportH = 0;
  let scrollTop = 0; // parent's scroll position
  let topOffset = 0; // this list's top within the parent's content box

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  function findScrollParent(node: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = node.parentElement;
    while (cur) {
      const o = getComputedStyle(cur).overflowY;
      if (o === "auto" || o === "scroll") return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /** Re-read scroll position + viewport + the list's own offset in the scroller. */
  function measure() {
    if (!scrollParent || !ul) return;
    scrollTop = scrollParent.scrollTop;
    viewportH = scrollParent.clientHeight;
    topOffset = ul.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top + scrollParent.scrollTop;
  }

  onMount(() => {
    scrollParent = findScrollParent(ul);
    measure();
    const onScroll = () => measure();
    scrollParent?.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => measure());
    if (scrollParent) ro.observe(scrollParent);
    return () => {
      scrollParent?.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  });

  $: total = items.length;
  $: winStart = scrollParent ? clamp(Math.floor((scrollTop - topOffset) / rowHeight) - overscan, 0, total) : 0;
  $: winEnd = scrollParent
    ? clamp(Math.ceil((scrollTop - topOffset + viewportH) / rowHeight) + overscan, winStart, total)
    : total;
  $: windowed = items.slice(winStart, winEnd);

  // ---- scroll anchoring across items changes --------------------------------
  let lastItems: readonly Item[] = items;
  let anchor: { key: string; screenOffset: number } | null = null;
  beforeUpdate(() => {
    if (anchorSuspended) {
      anchor = null;
      lastItems = items;
      return;
    }
    if (items === lastItems || !scrollParent || !ul) return;
    const firstVisible = clamp(Math.floor((scrollTop - topOffset) / rowHeight), 0, Math.max(0, lastItems.length - 1));
    const it = lastItems[firstVisible];
    if (it !== undefined) anchor = { key: getKey(it), screenOffset: topOffset + firstVisible * rowHeight - scrollTop };
  });
  afterUpdate(() => {
    if (items === lastItems) return;
    const a = anchor;
    lastItems = items;
    anchor = null;
    measure(); // sections above may have resized; row count changed
    if (!a || !scrollParent) return;
    const idx = items.findIndex((it) => getKey(it) === a.key);
    if (idx < 0) return;
    const want = Math.max(0, topOffset + idx * rowHeight - a.screenOffset);
    if (Math.abs(want - scrollParent.scrollTop) > 1) {
      scrollParent.scrollTop = want;
      measure();
    }
  });

  /** Map a clientY to a logical row index (drag targeting — WS-1 Fix 6d). */
  export function indexAtY(clientY: number): number {
    if (!scrollParent || !ul || !total) return 0;
    const yInContent = clientY - scrollParent.getBoundingClientRect().top + scrollParent.scrollTop - topOffset;
    return clamp(Math.floor(yInContent / rowHeight), 0, total - 1);
  }

  /** Scroll the parent so row `idx` is inside the viewport. */
  export function ensureVisible(idx: number) {
    if (!scrollParent) return;
    const rowTop = topOffset + idx * rowHeight;
    if (rowTop < scrollParent.scrollTop) scrollParent.scrollTop = rowTop;
    else if (rowTop + rowHeight > scrollParent.scrollTop + viewportH)
      scrollParent.scrollTop = rowTop + rowHeight - viewportH;
    measure();
  }
</script>

<ul bind:this={ul} class={listClass} data-total={total} data-win-start={winStart} style={`--vrow-h:${rowHeight}px`}>
  <li class="vspacer" aria-hidden="true" style={`height:${winStart * rowHeight}px`}></li>
  {#each windowed as item, i (getKey(item))}
    <slot {item} index={winStart + i} />
  {/each}
  <li class="vspacer" aria-hidden="true" style={`height:${Math.max(0, total - winEnd) * rowHeight}px`}></li>
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .vspacer {
    display: block;
    padding: 0;
    margin: 0;
    border: none;
  }
</style>
