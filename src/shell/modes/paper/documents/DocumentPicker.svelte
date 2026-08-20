<script lang="ts">
  // F4: the project's document list, under the Outline in the Paper left rail.
  // Lists every .qmd, highlights the active one, and offers "+ New document".
  //
  // The list order is the USER'S: drag a row to slide it up or down, exactly as
  // the sidebar's Figures list works (Alt+↑/↓ moves a focused row from the
  // keyboard). What the drag produces is an ORDER only — no file is renamed or
  // moved on disk; `documentOrder` in project.json records it (docOrder.ts).
  //
  // As in the Figures list the WHOLE row is the drag surface, so a press only
  // becomes a drag past a small threshold, the click that ends a real drag is
  // swallowed (it must not also open the document), and pointer capture is
  // claimed at that same threshold so a plain click still lands on its button.
  // The two groups are separate lists on screen and a drag stays inside its own.
  import { tick } from "svelte";
  import type { DocEntry } from "./documents";

  let {
    docs,
    activePath,
    onSelect,
    onNew,
    onReorder,
  }: {
    docs: DocEntry[];
    activePath: string;
    onSelect: (path: string) => void;
    onNew: () => void;
    /** Move `path` so it lands at `toIndex` among the rows that stay put, within
     *  its own group. No-op when the picker is read-only (no handler). */
    onReorder?: (path: string, toIndex: number) => void;
  } = $props();

  type Group = "doc" | "ctx";
  const HINT = "Drag a row to reorder the list · Alt+↑/↓ moves a focused row";
  const DRAG_SLOP = 4; // px of movement before a press is a drag

  const rowsIn = (g: Group) => docs.filter((d) => (g === "ctx" ? !!d.isContext : !d.isContext));

  let docListEl = $state<HTMLUListElement | undefined>(undefined);
  let ctxListEl = $state<HTMLUListElement | undefined>(undefined);
  let dragPath = $state<string | null>(null); // the row being dragged (drives .dragging)
  let dragFrom: { path: string; group: Group; x: number; y: number } | null = null;
  let dragMoved = false; // a drag happened → swallow its trailing click

  /** Index of the row under `y` in that group's list (rows are keyed, so these
   *  rects stay in step with the live reordering). */
  function rowIndexAtY(g: Group, y: number): number {
    const rows = [...((g === "ctx" ? ctxListEl : docListEl)?.children ?? [])] as HTMLElement[];
    for (let i = 0; i < rows.length; i++) if (y < rows[i].getBoundingClientRect().bottom) return i;
    return rows.length - 1;
  }

  function startDrag(e: PointerEvent, path: string, group: Group) {
    if (e.button !== 0) return;
    dragFrom = { path, group, x: e.clientX, y: e.clientY };
    dragMoved = false;
  }

  function onDragMove(e: PointerEvent) {
    if (!dragFrom || !onReorder) return;
    const { group } = dragFrom;
    if (!dragPath) {
      const far =
        Math.abs(e.clientY - dragFrom.y) >= DRAG_SLOP || Math.abs(e.clientX - dragFrom.x) >= DRAG_SLOP;
      if (!far) return;
      dragPath = dragFrom.path;
      dragMoved = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {} // a synthetic pointer (headless gates) has nothing to capture
    }
    const rows = rowsIn(group);
    const first = rows.findIndex((d) => d.path === dragPath);
    const over = rowIndexAtY(group, e.clientY);
    if (first < 0 || over < 0 || over === first) return;
    onReorder(dragPath, over);
  }

  function endDrag(e: PointerEvent) {
    if (dragPath) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
    }
    dragFrom = null;
    dragPath = null; // dragMoved survives until the next pointerdown
  }

  function pick(path: string) {
    if (dragMoved) return; // this click ended a reorder drag, not a click
    onSelect(path);
  }

  /** Alt+↑/↓ on a focused row — the same move from the keyboard (the editor's
   *  "move this block up a list" chord). Scoped to the row, because inside the
   *  editor Alt+↑/↓ is CodeMirror's move-line. */
  async function onRowKey(e: KeyboardEvent, path: string, group: Group) {
    if (!onReorder || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const rows = rowsIn(group);
    const i = rows.findIndex((d) => d.path === path);
    const to = i + (e.key === "ArrowUp" ? -1 : 1);
    if (i < 0 || to < 0 || to >= rows.length) return; // already against that end
    e.preventDefault();
    e.stopPropagation();
    onReorder(path, to);
    // Reordering MOVES the row's DOM node, and an insertBefore-style move is not
    // focus-preserving — the row goes blurred, which made the chord a one-shot
    // (you had to click the row again between presses). Put focus back on the
    // row that moved so Alt+↓ Alt+↓ walks it down the list. It only bit one
    // direction: for a move UP the keyed diff relocates the OTHER row instead.
    await tick();
    focusRow(path, group);
  }

  function focusRow(path: string, group: Group) {
    const list = group === "ctx" ? ctxListEl : docListEl;
    const btn = [...(list?.querySelectorAll(".dp-item") ?? [])].find(
      (b) => b.getAttribute("title") === path,
    ) as HTMLElement | undefined;
    btn?.focus();
  }
</script>

<aside class="docpicker">
  <div class="dp-head" title={HINT}>Documents</div>
  <ul bind:this={docListEl}>
    {#each rowsIn("doc") as d (d.path)}
      <li
        class="dp-row"
        class:dragging={dragPath === d.path}
        onpointerdown={(e) => startDrag(e, d.path, "doc")}
        onpointermove={onDragMove}
        onpointerup={endDrag}
        onpointercancel={endDrag}>
        <button
          class="dp-item"
          class:active={d.path === activePath}
          title={d.path}
          onclick={() => pick(d.path)}
          onkeydown={(e) => onRowKey(e, d.path, "doc")}>
          <span class="dp-title">{d.title}</span>
          {#if d.isMain}<span class="dp-badge">main</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if docs.some((d) => d.isContext)}
    <div class="dp-head dp-ctx" title={HINT}>Context</div>
    <ul bind:this={ctxListEl}>
      {#each rowsIn("ctx") as d (d.path)}
        <li
          class="dp-row"
          class:dragging={dragPath === d.path}
          onpointerdown={(e) => startDrag(e, d.path, "ctx")}
          onpointermove={onDragMove}
          onpointerup={endDrag}
          onpointercancel={endDrag}>
          <button
            class="dp-item"
            class:active={d.path === activePath}
            title={d.path}
            onclick={() => pick(d.path)}
            onkeydown={(e) => onRowKey(e, d.path, "ctx")}>
            <span class="dp-title">{d.title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <button class="dp-new" onclick={onNew}>+ New document</button>
</aside>

<style>
  .docpicker {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px;
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    background: var(--flx-paper);
    color: var(--c-tx);
    max-height: 38%;
    overflow: auto;
  }
  .dp-head {
    font-size: var(--ts-xs, 11px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
    padding: 2px 4px 6px;
  }
  .dp-ctx {
    margin-top: 8px;
    border-top: 1px solid var(--c-line, var(--c-edge));
    padding-top: 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .dp-row.dragging .dp-item {
    /* the row being slid: keep it readable but clearly "in hand" */
    opacity: 0.65;
    background: var(--c-ui-hover);
  }
  .dp-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--r-1);
    padding: 5px 7px;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm, 13px);
    cursor: pointer;
  }
  .dp-item:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .dp-item.active {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
    font-weight: 600;
  }
  .dp-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dp-badge {
    flex: 0 0 auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-accent-bright);
    border: 1px solid var(--c-edge);
    border-radius: var(--r-pill, 999px);
    padding: 0 5px;
  }
  .dp-new {
    margin-top: 6px;
    text-align: left;
    background: none;
    border: 1px dashed var(--c-edge);
    border-radius: var(--r-1);
    padding: 5px 7px;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-sm, 13px);
    cursor: pointer;
  }
  .dp-new:hover {
    color: var(--c-accent-bright);
    border-color: var(--c-accent);
  }
</style>
