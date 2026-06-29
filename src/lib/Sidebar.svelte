<script lang="ts">
  import {
    project,
    activeFigureId,
    activeCanvasId,
    selection,
    selectOnly,
    commit,
    blankFigure,
    addCanvas,
    deleteCanvas,
    setActiveCanvas,
    figuresOnCanvas,
  } from "./store";
  import type { Figure } from "./types";

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
  let editing: { kind: "canvas" | "figure"; id: string } | null = null;
  let editVal = "";
  function startRename(kind: "canvas" | "figure", id: string, current: string) {
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
      } else {
        const f = p.figures.find((f) => f.id === id);
        if (f) f.name = name;
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
  // top-most element first in the layers list
  $: layers = activeFig ? [...activeFig.elements].reverse() : [];

  function labelFor(type: string, i: number) {
    return `${type} ${i}`;
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
    <ul>
      {#each layers as el, i (el.id)}
        <li class:active={$selection.has(el.id)}>
          <button class="item" on:click={() => selectOnly(el.id)}>
            {el.name ?? labelFor(el.type, layers.length - i)}
          </button>
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
