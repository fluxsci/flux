<script lang="ts" module>
  export interface GridItem {
    /** Stable id (the file's absolute path). */
    id: string;
    /** Width / height for layout. */
    aspect: number;
    /** > 0: a full-width block of this height (a table card, a "Show all" row). */
    block?: number;
    data: unknown;
  }
  export interface GridSection {
    key: string;
    title: string;
    /** Shown after the title (a count, a hint). */
    meta?: string;
    depth: number;
    collapsed: boolean;
    collapsible: boolean;
    /** Header height; 0 hides the header (a flat list). */
    headerH: number;
    items: GridItem[];
    /** Section-header menu (e.g. the dissections group jump menu). */
    onHeaderMenu?: (e: MouseEvent) => void;
  }
  export interface TileFlags { selected: boolean; focused: boolean; linked: boolean; priority: number }
</script>

<script lang="ts">
  // The Plots rail's grid (shared by the Gallery and Dissections panes): sections with headers,
  // justified rows (justify.ts), windowed — only the rows within a screen of the viewport exist —
  // and a STUCK header overlay for the section under the top edge (pushed up by the next one).
  // Keyboard: arrows move in reading order and between rows by nearest centre; Home/End,
  // PageUp/PageDown. Everything else is the pane's (onKeyDown). Scroll math runs on scroll
  // events only, coalesced to one per frame; nothing runs at rest.
  import type { Snippet } from "svelte";
  import { layoutJustified, firstRowAt, sectionAt, moveIndex, type JustifyLayout } from "./justify";
  // Native listeners, not Svelte's delegated ones: the Dissect viewers mount this grid inside
  // the Plot gallery, whose subtree can be adopted by a pinned utility window.
  import { nativeClick, nativeDoubleClick, nativeContextMenu, nativePointerDown, nativePointerMove, nativeKeyDown } from "../ui/nativeEvents";

  let {
    sections,
    rowHeight,
    captionH,
    gap = 6,
    blockGap,
    padX = 8,
    selected,
    focusId = "",
    linkedId = "",
    tile,
    minAspect = 0.6,
    label,
    emptyText = "",
    onItemPress,
    onItemOpen,
    onItemContext,
    onItemPointerDown,
    onHeaderToggle,
    onFocusChange,
    onKeyDown,
    onZoom,
    onScrollState,
    onItemHover,
    onHeaderContext,
    onScrolled,
  }: {
    sections: GridSection[];
    rowHeight: number;
    captionH: number;
    gap?: number;
    blockGap?: number;
    padX?: number;
    selected: Set<string>;
    focusId?: string;
    linkedId?: string;
    tile: Snippet<[GridItem, number, number, TileFlags]>;
    minAspect?: number;
    label: string;
    emptyText?: string;
    onItemPress?: (item: GridItem, e: MouseEvent) => void;
    onItemOpen?: (item: GridItem, e: MouseEvent) => void;
    onItemContext?: (item: GridItem, e: MouseEvent) => void;
    onItemPointerDown?: (item: GridItem, e: PointerEvent) => void;
    onHeaderToggle?: (section: GridSection, e: MouseEvent) => void;
    onFocusChange?: (item: GridItem, via: "keyboard") => void;
    onKeyDown?: (e: KeyboardEvent, focused: GridItem | null) => void;
    onZoom?: (delta: number, anchorId: string) => void;
    onScrollState?: (s: { top: number; firstVisible: number }) => void;
    /** The pointer entered a different cell (null: it left every cell) — Peek's dwell. */
    onItemHover?: (item: GridItem | null, cell: HTMLElement | null) => void;
    onHeaderContext?: (section: GridSection, e: MouseEvent) => void;
    /** The user scrolled (Peek hides). */
    onScrolled?: () => void;
  } = $props();

  let viewport = $state<HTMLDivElement>();
  // DOM ids for aria-activedescendant: per grid instance (both panes share the document).
  const uid = `jg${Math.random().toString(36).slice(2, 8)}`;
  let width = $state(0);
  let height = $state(0);
  let scrollTop = $state(0);
  let raf = 0;

  // Flat order of the items that are laid out (collapsed sections contribute none).
  const flat = $derived.by(() => {
    const out: GridItem[] = [];
    for (const s of sections) if (!s.collapsed) out.push(...s.items);
    return out;
  });
  const indexOf = $derived.by(() => {
    const m = new Map<string, number>();
    flat.forEach((it, i) => m.set(it.id, i));
    return m;
  });
  const layout: JustifyLayout = $derived(layoutJustified(
    sections.map((s) => ({ key: s.key, headerH: s.headerH, aspects: s.collapsed ? [] : s.items.map((i) => i.aspect), blocks: s.collapsed ? [] : s.items.map((i) => i.block ?? 0) })),
    { width: Math.max(40, width - 2 * padX), rowHeight, gap, blockGap, captionH, padTop: 0, sectionGap: 4, minAspect, maxAspect: 6, minRowH: 40 },
  ));

  const overscan = $derived(Math.max(200, height));
  const firstRow = $derived(firstRowAt(layout, scrollTop - overscan));
  const visibleRows = $derived.by(() => {
    const out = [];
    const bottom = scrollTop + height + overscan;
    for (let r = firstRow; r < layout.rows.length && layout.rows[r].y < bottom; r++) out.push(r);
    return out;
  });
  const firstVisibleIndex = $derived.by(() => {
    const r = firstRowAt(layout, scrollTop);
    return layout.rows[r]?.items[0]?.index ?? 0;
  });
  const visibleSections = $derived(layout.sections.map((s, i) => i).filter((i) => {
    const s = layout.sections[i];
    return sections[i].headerH > 0 && s.y + s.headerH >= scrollTop - overscan && s.y <= scrollTop + height + overscan;
  }));
  // The stuck header: the section under the top edge, once its own header has scrolled past.
  const stuck = $derived.by(() => {
    const i = sectionAt(layout, scrollTop);
    if (i < 0 || !sections[i] || sections[i].headerH === 0) return null;
    const s = layout.sections[i];
    if (s.y >= scrollTop) return null;
    const next = layout.sections[i + 1];
    const push = next ? Math.min(0, next.y - scrollTop - sections[i].headerH) : 0;
    return { index: i, offset: push };
  });

  $effect(() => {
    const el = viewport;
    if (!el) return;
    const view = el.ownerDocument.defaultView as Window & typeof globalThis;
    const ro = new view.ResizeObserver(() => { width = el.clientWidth; height = el.clientHeight; });
    ro.observe(el);
    width = el.clientWidth; height = el.clientHeight;
    return () => { ro.disconnect(); if (raf) view.cancelAnimationFrame(raf); };
  });

  $effect(() => { onScrollState?.({ top: scrollTop, firstVisible: firstVisibleIndex }); });

  function onScroll() {
    onScrolled?.();
    // Content moved under the pointer (and Peek hid): the next pointer move re-dwells.
    hovered = "";
    if (raf || !viewport) return;
    const view = viewport.ownerDocument.defaultView!;
    raf = view.requestAnimationFrame(() => { raf = 0; if (viewport) scrollTop = viewport.scrollTop; });
  }

  /** Bring an item into view: "nearest" scrolls only if it is (partly) off-screen; "center"
   *  centres it when off-screen. Returns false when the item is not laid out. */
  export function reveal(id: string, mode: "nearest" | "center" = "nearest"): boolean {
    const i = indexOf.get(id);
    if (i === undefined || !viewport) return false;
    const row = layout.rows[layout.itemRow[i]];
    if (!row) return false;
    const top = row.y, bottom = row.y + row.h + row.cap;
    const vt = viewport.scrollTop, vb = vt + viewport.clientHeight;
    const stuckH = 26;
    if (top >= vt + stuckH && bottom <= vb) return true;
    let next: number;
    if (mode === "center") next = top - (viewport.clientHeight - (bottom - top)) / 2;
    else next = top < vt + stuckH ? top - stuckH - 4 : bottom - viewport.clientHeight + 4;
    viewport.scrollTop = Math.max(0, next);
    scrollTop = viewport.scrollTop;
    return true;
  }
  export function focusGrid() { viewport?.focus({ preventScroll: true }); }
  export function scrollToTop() { if (viewport) { viewport.scrollTop = 0; scrollTop = 0; } }
  /** Keep `id` at the same screen offset across a relayout (zoom, sizes arriving). */
  export function anchorTo(id: string, screenY: number) {
    const i = indexOf.get(id);
    if (i === undefined || !viewport) return;
    const row = layout.rows[layout.itemRow[i]];
    if (!row) return;
    viewport.scrollTop = Math.max(0, row.y - screenY);
    scrollTop = viewport.scrollTop;
  }
  export function screenYOf(id: string): number | null {
    const i = indexOf.get(id);
    if (i === undefined || !viewport) return null;
    const row = layout.rows[layout.itemRow[i]];
    return row ? row.y - viewport.scrollTop : null;
  }
  export function firstVisibleId(): string { return flat[firstVisibleIndex]?.id ?? ""; }
  /** The laid-out width of an item (null: not laid out — its section is collapsed). */
  export function widthOf(id: string): number | null {
    const i = indexOf.get(id);
    if (i === undefined) return null;
    const row = layout.rows[layout.itemRow[i]];
    return row?.items.find((p) => p.index === i)?.w ?? null;
  }
  export function itemRect(id: string): DOMRect | null {
    const node = viewport?.querySelector<HTMLElement>(`[data-grid-id="${CSS.escape(id)}"]`);
    return node ? node.getBoundingClientRect() : null;
  }

  /** Arrows, Home/End and PageUp/PageDown move the focus (true: the key was one of them).
   *  Exported for hosts that capture keys before the grid sees them. */
  export function navigate(e: KeyboardEvent): boolean {
    const focused = focusId ? flat[indexOf.get(focusId) ?? -1] ?? null : null;
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (!e.altKey && !e.ctrlKey && !e.metaKey && (dirs[e.key] || ["Home", "End", "PageUp", "PageDown"].includes(e.key))) {
      e.preventDefault();
      if (!flat.length) return true;
      let i = focused ? indexOf.get(focused.id)! : -1;
      if (dirs[e.key]) i = i < 0 ? 0 : moveIndex(layout, i, dirs[e.key]);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = flat.length - 1;
      else {
        // A page: the item nearest the same x one viewport further.
        const cur = i < 0 ? 0 : i;
        const row = layout.rows[layout.itemRow[cur]];
        const targetY = row.y + (e.key === "PageDown" ? height : -height) * 0.9;
        let best = cur;
        for (const r of layout.rows) if (Math.abs(r.y - targetY) < Math.abs(layout.rows[layout.itemRow[best]].y - targetY)) best = r.items[0].index;
        i = best;
      }
      const item = flat[i];
      if (item) { onFocusChange?.(item, "keyboard"); reveal(item.id); }
      return true;
    }
    return false;
  }
  function keydown(e: KeyboardEvent) {
    if (!navigate(e)) onKeyDown?.(e, focusId ? flat[indexOf.get(focusId) ?? -1] ?? null : null);
  }

  // Hover, delegated: one listener for every cell. Pointer MOVES (not just `over`), so a pointer
  // resting on a tile after a scroll starts a new dwell with its first nudge.
  let hovered = "";
  function pointerOver(e: PointerEvent) {
    if (!onItemHover || e.pointerType === "touch") return;
    const cell = (e.target as HTMLElement).closest?.<HTMLElement>("[data-grid-id]") ?? null;
    const id = cell?.dataset.gridId ?? "";
    if (id === hovered) return;
    hovered = id;
    const item = id ? flat[indexOf.get(id) ?? -1] ?? null : null;
    onItemHover(item, item ? cell : null);
  }
  function pointerLeave() {
    if (!hovered) return;
    hovered = "";
    onItemHover?.(null, null);
  }

  function wheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey) || !onZoom) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-grid-id]");
    onZoom(e.deltaY < 0 ? 1 : -1, target?.dataset.gridId ?? firstVisibleId());
  }
</script>

<div class="grid-wrap">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="viewport"
    bind:this={viewport}
    tabindex="0"
    role="listbox"
    aria-label={label}
    aria-multiselectable="true"
    aria-activedescendant={focusId && indexOf.has(focusId) ? `${uid}-${indexOf.get(focusId)}` : undefined}
    onscroll={onScroll}
    use:nativeKeyDown={keydown}
    onwheel={wheel}
    use:nativePointerMove={pointerOver}
    onpointerleave={pointerLeave}>
    <div class="spacer" style:height={`${layout.height + 8}px`}>
      {#each visibleSections as si (sections[si].key)}
        {@const sec = sections[si]}
        {@const place = layout.sections[si]}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="section-head" role="presentation" use:nativeContextMenu={(e) => { if (onHeaderContext) { e.preventDefault(); onHeaderContext(sec, e); } }} style:top={`${place.y}px`} style:height={`${sec.headerH}px`} style:padding-left={`${padX + sec.depth * 8}px`} data-section={sec.key}>
          {#if sec.collapsible}
            <button class="chev" aria-expanded={!sec.collapsed} aria-label={`${sec.collapsed ? "Expand" : "Collapse"} ${sec.title}`} use:nativeClick={(e) => onHeaderToggle?.(sec, e)}>{sec.collapsed ? "▸" : "▾"}</button>
          {/if}
          {#if sec.onHeaderMenu}
            <button class="title as-menu" title="Jump to a group" use:nativeClick={(e) => sec.onHeaderMenu?.(e)}>{sec.title}<span class="meta">{sec.meta ?? ""}</span><span class="caret">▾</span></button>
          {:else}
            <span class="title" title={sec.title}>{sec.title}<span class="meta">{sec.meta ?? ""}</span></span>
          {/if}
        </div>
      {/each}
      {#each visibleRows as r (r)}
        {@const row = layout.rows[r]}
        {#each row.items as placed (flat[placed.index]?.id ?? placed.index)}
          {@const item = flat[placed.index]}
          {#if item}
            {@const flags = { selected: selected.has(item.id), focused: item.id === focusId, linked: item.id === linkedId, priority: Math.abs(placed.index - firstVisibleIndex) }}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="cell"
              class:block={row.block}
              id={`${uid}-${placed.index}`}
              role="option"
              tabindex="-1"
              aria-selected={flags.selected}
              data-grid-id={item.id}
              style:left={`${padX + placed.x}px`}
              style:top={`${row.y}px`}
              style:width={`${placed.w}px`}
              style:height={`${row.h + row.cap}px`}
              use:nativeClick={(e) => onItemPress?.(item, e)}
              use:nativeDoubleClick={(e) => onItemOpen?.(item, e)}
              use:nativeContextMenu={(e) => onItemContext?.(item, e)}
              use:nativePointerDown={(e) => onItemPointerDown?.(item, e as PointerEvent)}>
              {@render tile(item, placed.w, row.h, flags)}
            </div>
          {/if}
        {/each}
      {/each}
    </div>
    {#if !flat.length && !sections.some((s) => s.headerH > 0) && emptyText}
      <div class="empty">{emptyText}</div>
    {/if}
  </div>
  {#if stuck}
    {@const sec = sections[stuck.index]}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="section-head stuck" role="presentation" use:nativeContextMenu={(e) => { if (onHeaderContext) { e.preventDefault(); onHeaderContext(sec, e); } }} style:top={`${stuck.offset}px`} style:height={`${sec.headerH}px`} style:padding-left={`${padX}px`} data-stuck={sec.key}>
      {#if sec.collapsible}
        <button class="chev" aria-expanded={!sec.collapsed} aria-label={`Collapse ${sec.title}`} use:nativeClick={(e) => onHeaderToggle?.(sec, e)}>▾</button>
      {/if}
      {#if sec.onHeaderMenu}
        <button class="title as-menu" title="Jump to a group" use:nativeClick={(e) => sec.onHeaderMenu?.(e)}>{sec.title}<span class="meta">{sec.meta ?? ""}</span><span class="caret">▾</span></button>
      {:else}
        <span class="title" title={sec.title}>{sec.title}<span class="meta">{sec.meta ?? ""}</span></span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .grid-wrap { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; }
  .viewport { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; outline: none; contain: strict; scrollbar-gutter: stable; }
  /* The focused tile carries the focus ring; the list itself shows none. */
  .spacer { position: relative; width: 100%; }
  .cell { position: absolute; box-sizing: border-box; outline: none; }
  .section-head { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 2px; padding-right: 6px; box-sizing: border-box; font: 600 10.5px var(--font-mono); color: var(--c-tx-2); white-space: nowrap; overflow: hidden; }
  .section-head.stuck { z-index: 2; background: var(--c-bg-raised); border-bottom: 1px solid var(--c-line); }
  .chev { flex: 0 0 16px; width: 16px; height: 18px; padding: 0; border: 0; background: none; color: var(--c-tx-muted); font-size: 10px; cursor: var(--cursor-cross-hover); }
  .chev:hover { color: var(--c-tx-hi); }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; letter-spacing: .02em; line-height: 16px; padding-bottom: 1px; }
  .as-menu { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 20px; padding: 0 4px; border: 0; border-radius: var(--r-ui); background: none; color: inherit; font: inherit; cursor: var(--cursor-cross-hover); }
  .as-menu:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .caret { color: var(--c-tx-muted); font-size: 9px; }
  .meta { margin-left: 6px; color: var(--c-tx-faint); font-weight: 400; }
  .empty { padding: 18px 12px; color: var(--c-tx-muted); font: 12px var(--font-ui); text-align: center; }
</style>
