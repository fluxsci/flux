<script lang="ts">
  // The reader's tab strip — one slim row above the document. Pure presentation:
  // the tab list + active key come in as props, every mutation goes back through
  // callbacks (readerStore owns the semantics). Labels come from the live FluxLib
  // mirror (fluxLibEntries) and fall back to the citekey until it populates.
  import { fluxLibEntries } from "../../../lib/references/revision";
  import type { ReaderTab } from "./readerStore";

  let {
    tabs,
    activeKey,
    onActivate,
    onClose,
    onSplit,
    onMove,
  }: {
    tabs: ReaderTab[];
    activeKey: string | null;
    onActivate: (key: string) => void;
    onClose: (key: string) => void;
    /** Alt/Cmd-click a tab → open it in the other pane (titlebar split convention). */
    onSplit?: (key: string) => void;
    /** Drag-reorder: move `key` to `toIndex` in strip order. */
    onMove?: (key: string, toIndex: number) => void;
  } = $props();

  const titleByKey = $derived(new Map($fluxLibEntries.map((e) => [e.key, e.title])));
  const label = (key: string) => titleByKey.get(key) || key;

  // Drag-reorder, browser-tab style: the strip reorders LIVE as the pointer crosses a
  // neighbour's midpoint (no ghost element — the keyed each preserves every tab's DOM
  // and no document remounts, since only order changes). A drag suppresses the click
  // that would otherwise activate the tab.
  let strip = $state<HTMLElement | undefined>();
  let dragKey: string | null = null;
  let dragStartX = 0;
  let dragged = $state(false);

  function onTabPointerDown(e: PointerEvent, key: string) {
    if (e.button !== 0 || !onMove || tabs.length < 2) return;
    dragKey = key;
    dragStartX = e.clientX;
    dragged = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onTabPointerMove(e: PointerEvent) {
    if (dragKey === null) return;
    if (!dragged) {
      if (Math.abs(e.clientX - dragStartX) < 5) return; // a click, not a drag
      dragged = true;
      document.body.style.userSelect = "none"; // never preventDefault here (§9: kills dblclick)
    }
    const rects = [...(strip?.querySelectorAll<HTMLElement>(".rtab") ?? [])].map((el) => ({
      key: el.dataset.key!,
      box: el.getBoundingClientRect(),
    }));
    let target = rects.findIndex((r) => e.clientX < r.box.left + r.box.width / 2);
    if (target < 0) target = rects.length - 1;
    if (rects[target]?.key !== dragKey) onMove?.(dragKey, target);
  }
  function endDrag(e: PointerEvent) {
    if (dragKey === null) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragKey = null;
    document.body.style.userSelect = "";
    // Clear AFTER the click that follows this pointerup would have fired.
    if (dragged) setTimeout(() => (dragged = false), 0);
  }
</script>

<div class="rtabs" data-testid="reader-tabs" role="tablist" aria-label="Open papers" bind:this={strip} class:dragging={dragged}>
  {#each tabs as t (t.key)}
    <div class="rtab" class:on={t.key === activeKey} data-key={t.key}>
      <button
        class="rtab-main"
        role="tab"
        aria-selected={t.key === activeKey}
        title={`${label(t.key)}  (Alt-click: open in split · drag to reorder)`}
        onpointerdown={(e) => onTabPointerDown(e, t.key)}
        onpointermove={onTabPointerMove}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onclick={(e) => {
          if (dragged) return; // this click ends a reorder drag
          if (e.altKey || e.metaKey) (onSplit ?? onActivate)(t.key);
          else onActivate(t.key);
        }}
        onauxclick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose(t.key);
          }
        }}>{label(t.key)}</button>
      <button
        class="rtab-x"
        title="Close (Ctrl+W)"
        aria-label={`Close ${label(t.key)}`}
        onclick={() => onClose(t.key)}>×</button>
    </div>
  {/each}
</div>

<style>
  .rtabs {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 8px 0;
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .rtab {
    flex: 0 1 auto;
    display: flex;
    align-items: center;
    min-width: 72px;
    max-width: 220px;
    border: 1px solid var(--c-line);
    border-bottom: none;
    border-radius: var(--r-1) var(--r-1) 0 0;
    background: var(--c-bg);
    color: var(--c-tx-2);
  }
  .rtab.on {
    border-color: var(--c-line-strong);
    background: var(--c-bg-raised, var(--c-bg));
    color: var(--c-tx-1);
    box-shadow: inset 0 2px 0 var(--c-accent);
  }
  .rtab-main {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    font-size: var(--ts-xs);
    text-align: left;
    padding: 4px 2px 4px 9px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .rtabs.dragging .rtab-main {
    cursor: grabbing;
  }
  .rtab-x {
    flex: 0 0 auto;
    border: none;
    background: none;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-sm);
    line-height: 1;
    padding: 2px 7px 2px 3px;
    cursor: pointer;
    border-radius: var(--r-1);
  }
  .rtab-x:hover {
    color: var(--c-danger);
  }
</style>
