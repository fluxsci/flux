<script lang="ts">
  import {
    project,
    activeFigureId,
    activeCanvasId,
    selection,
    selectOnly,
    commit,
    mutate,
    beginGesture,
    blankFigure,
    addCanvas,
    deleteCanvas,
    setActiveCanvas,
    figuresOnCanvas,
  } from "./store";
  import type { Element, Figure } from "./types";
  import * as ops from "./ops";

  function addFigure() {
    const cid = $activeCanvasId;
    commit((p) => {
      const onCanvas = p.figures.filter((f) => f.canvasId === cid);
      const active = p.figures.find((f) => f.id === $activeFigureId && f.canvasId === cid);
      // New figures stack vertically: directly below the lowest figure on the
      // canvas, left-aligned with the active figure (M1 / F8). The default size
      // lives only in blankFigure() (816×1056) so figure sizes never drift.
      const gap = 80;
      const maxBottom = onCanvas.reduce((m, f) => Math.max(m, f.y + f.height), 0);
      const fig: Figure = {
        ...blankFigure(cid!, `Figure ${onCanvas.length + 1}`),
        x: onCanvas.length ? active?.x ?? onCanvas[0].x : 0,
        y: onCanvas.length ? maxBottom + gap : 0,
      };
      p.figures.push(fig);
      activeFigureId.set(fig.id);
    });
  }

  function deleteFigure(id: string) {
    const cid = $activeCanvasId;
    commit((p) => {
      p.figures = p.figures.filter((f) => f.id !== id);
      // Never leave a canvas with no figures.
      if (p.figures.filter((f) => f.canvasId === cid).length === 0) {
        p.figures.push(blankFigure(cid!));
      }
    });
    activeFigureId.set(figuresOnCanvas($project, cid)[0]?.id ?? null);
  }

  // M11: inline rename (no blocking native window.prompt). Double-click a row to
  // edit; Enter / blur commits, Esc cancels.
  let editing: { kind: "canvas" | "figure" | "layer"; id: string } | null = null;
  let editVal = "";
  function startRename(kind: "canvas" | "figure" | "layer", id: string, current: string) {
    editing = { kind, id };
    editVal = current;
  }
  function commitRename() {
    if (!editing) return;
    const { kind, id } = editing;
    const name = editVal.trim();
    editing = null;
    if (!name) return;
    commit((p) => {
      if (kind === "canvas") {
        const c = p.canvases.find((c) => c.id === id);
        if (c) c.name = name;
      } else if (kind === "figure") {
        const f = p.figures.find((f) => f.id === id);
        if (f) f.name = name;
      } else {
        ops.setElementStyle(p, [id], { name });
      }
    });
  }
  function cancelRename() {
    editing = null;
  }
  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") cancelRename();
  }

  // Figures on the active canvas only.
  $: canvasFigures = $project.figures.filter((f) => f.canvasId === $activeCanvasId);
  $: activeFig = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  // top-most element first in the layers list (z-order = array order, reversed)
  $: layers = activeFig ? [...activeFig.elements].reverse() : [];

  function labelFor(type: string, i: number) {
    return `${type} ${i}`;
  }

  // --- Layer visibility / lock toggles (shared op, one undo each) ---
  function toggleHidden(el: Element) {
    commit((p) => ops.setElementStyle(p, [el.id], { hidden: !el.hidden }));
  }
  function toggleLocked(el: Element) {
    commit((p) => ops.setElementStyle(p, [el.id], { locked: !el.locked }));
  }

  // --- Drag-to-reorder (z-order). Grip pointerdown starts a drag; moving over a
  // row reorders live (one deferred beginGesture → one undo for the whole drag). ---
  let dragId: string | null = null;
  let dragBegan = false;
  let layersUl: HTMLUListElement;

  function startLayerDrag(e: PointerEvent, el: Element) {
    e.preventDefault();
    e.stopPropagation();
    dragId = el.id;
    dragBegan = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onLayerDragMove(e: PointerEvent) {
    if (!dragId || !layersUl) return;
    const rows = [...layersUl.querySelectorAll("li.layer")] as HTMLElement[];
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    const cur = layers.findIndex((l) => l.id === dragId);
    if (cur < 0 || to === cur) return;
    if (!dragBegan) {
      beginGesture();
      dragBegan = true;
    }
    const fid = $activeFigureId;
    const id = dragId;
    // display index `to` (0 = top) → array index (0 = bottom)
    mutate((p) => ops.reorderElement(p, fid!, id, layers.length - 1 - to));
  }
  function endLayerDrag(e: PointerEvent) {
    if (!dragId) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    dragId = null;
    dragBegan = false;
  }
</script>

<aside class="sidebar">
  <section>
    <div class="head">
      <h4>Canvases</h4>
      <button class="mini" on:click={addCanvas} title="Add canvas">+</button>
    </div>
    <ul>
      {#each $project.canvases as canvas (canvas.id)}
        <li class:active={$activeCanvasId === canvas.id}>
          {#if editing && editing.kind === "canvas" && editing.id === canvas.id}
            <input
              class="rename"
              bind:value={editVal}
              use:focusSelect
              on:keydown={onRenameKey}
              on:blur={commitRename} />
          {:else}
            <button
              class="item"
              on:click={() => setActiveCanvas(canvas.id)}
              on:dblclick={() => startRename("canvas", canvas.id, canvas.name)}
              title="Click to switch · double-click to rename">{canvas.name}</button
            >
          {/if}
          {#if $project.canvases.length > 1}
            <button class="del" on:click={() => deleteCanvas(canvas.id)} title="Delete canvas">×</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <div class="head">
      <h4>Figures</h4>
      <button class="mini" on:click={addFigure} title="Add figure">+</button>
    </div>
    <ul>
      {#each canvasFigures as fig, i (fig.id)}
        <li class:active={$activeFigureId === fig.id}>
          <span class="fnum" title="Figure number (by order)">{i + 1}</span>
          {#if editing && editing.kind === "figure" && editing.id === fig.id}
            <input
              class="rename"
              bind:value={editVal}
              use:focusSelect
              on:keydown={onRenameKey}
              on:blur={commitRename} />
          {:else}
            <button
              class="item"
              on:click={() => activeFigureId.set(fig.id)}
              on:dblclick={() => startRename("figure", fig.id, fig.name)}
              title="Click to switch · double-click to rename">{fig.name}</button
            >
          {/if}
          <button class="del" on:click={() => deleteFigure(fig.id)} title="Delete figure">×</button>
        </li>
      {/each}
    </ul>
  </section>

  <section class="layers">
    <h4>Layers</h4>
    <ul bind:this={layersUl}>
      {#each layers as el, i (el.id)}
        <li
          class="layer"
          class:active={$selection.has(el.id)}
          class:dragging={dragId === el.id}
          class:isHidden={el.hidden}
        >
          <button
            class="grip"
            title="Drag to reorder z-position"
            aria-label="Drag to reorder"
            on:pointerdown={(e) => startLayerDrag(e, el)}
            on:pointermove={onLayerDragMove}
            on:pointerup={endLayerDrag}
            on:pointercancel={endLayerDrag}
            on:click|preventDefault>⠿</button
          >
          <button
            class="tog"
            class:muted={el.hidden}
            title={el.hidden ? "Show" : "Hide"}
            aria-label="Toggle visibility"
            on:click={() => toggleHidden(el)}
          >
            {#if el.hidden}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.2" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><circle cx="8" cy="8" r="1.9" fill="currentColor" /></svg>
            {/if}
          </button>
          <button
            class="tog"
            class:on={el.locked}
            title={el.locked ? "Unlock" : "Lock"}
            aria-label="Toggle lock"
            on:click={() => toggleLocked(el)}
          >
            {#if el.locked}
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="currentColor" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
            {:else}
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
            {/if}
          </button>
          {#if editing && editing.kind === "layer" && editing.id === el.id}
            <input
              class="rename"
              bind:value={editVal}
              use:focusSelect
              on:keydown={onRenameKey}
              on:blur={commitRename} />
          {:else}
            <button
              class="item"
              on:click={() => selectOnly(el.id)}
              on:dblclick={() => startRename("layer", el.id, el.name ?? labelFor(el.type, layers.length - i))}
              title="Click to select · double-click to rename">
              {el.name ?? labelFor(el.type, layers.length - i)}
            </button>
          {/if}
          {#if el.type === "text" && el.panelLabel}
            <span class="plabel" title="Panel label (caption block)">{el.text.trim().slice(0, 3) || "¶"}</span>
          {/if}
        </li>
      {/each}
      {#if layers.length === 0}
        <li class="empty">No elements yet</li>
      {/if}
    </ul>
  </section>
</aside>

<style>
  .sidebar {
    width: 200px;
    background: var(--c-surface);
    border-right: 1px solid var(--c-line);
    overflow-y: auto;
    padding: 4px 8px;
    font-size: 13px;
    color: var(--c-tx);
  }
  section {
    padding: 8px 0;
    border-bottom: 1px solid var(--c-line);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h4 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.6;
    margin: 4px 0 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    border-radius: 5px;
  }
  li.active {
    background: var(--c-accent);
  }
  li.active .item {
    color: var(--c-on-accent);
  }
  .item {
    flex: 1;
    text-align: left;
    background: transparent;
    border: none;
    color: inherit;
    padding: 5px 8px;
    font-size: 13px;
    cursor: pointer;
    border-radius: 5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li:hover:not(.active) {
    background: var(--c-surface-2);
  }
  /* M14: order-derived figure number (always reflects position, never stale). */
  .fnum {
    flex: 0 0 auto;
    min-width: 14px;
    text-align: right;
    margin-left: 4px;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-muted);
    opacity: 0.7;
  }
  li.active .fnum {
    color: var(--c-on-accent);
    opacity: 0.85;
  }
  /* M11: inline rename input. */
  .rename {
    flex: 1;
    min-width: 0;
    margin: 0 4px;
    padding: 4px 6px;
    font: inherit;
    font-size: 13px;
    color: var(--c-tx);
    background: var(--c-bg-raised, var(--c-surface));
    border: 1px solid var(--c-accent);
    border-radius: 5px;
    outline: none;
  }
  .del,
  .mini {
    background: transparent;
    border: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    font-size: 15px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .del:hover,
  .mini:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .empty {
    opacity: 0.4;
    padding: 5px 8px;
    font-size: 12px;
  }
  /* F6 Layers: grip + eye/lock toggles per row */
  .layer {
    gap: 1px;
  }
  .layer.dragging {
    background: var(--c-accent-tint);
    box-shadow: inset 0 0 0 1px var(--c-accent);
  }
  .layer.isHidden .item {
    opacity: 0.5;
    font-style: italic;
  }
  .grip {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    color: var(--c-tx-muted);
    cursor: grab;
    padding: 4px 2px 4px 3px;
    font-size: 12px;
    line-height: 1;
    opacity: 0.55;
    touch-action: none;
  }
  .grip:hover {
    opacity: 1;
  }
  .layer.dragging .grip {
    cursor: grabbing;
  }
  .tog {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    padding: 3px;
    border-radius: 4px;
    opacity: 0.7;
  }
  .tog:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
    opacity: 1;
  }
  .tog.muted {
    opacity: 0.45;
  }
  .tog.on {
    color: var(--c-accent);
    opacity: 1;
  }
  li.active .grip,
  li.active .tog {
    color: var(--c-on-accent);
  }
  .plabel {
    flex: none;
    margin-right: 6px;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    padding: 2px 4px;
    border: 1px solid var(--c-accent);
    color: var(--c-accent);
    border-radius: 4px;
    font-family: var(--font-mono);
  }
  li.active .plabel {
    border-color: var(--c-on-accent);
    color: var(--c-on-accent);
  }
</style>
