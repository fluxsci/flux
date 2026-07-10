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
  import type { Element, Figure, GroupDef } from "./types";
  import * as ops from "./ops";
  import { buildRenderTree, membersDeep, type RenderNode } from "./groups";

  function addFigure() {
    const cid = $activeCanvasId;
    commit((p) => {
      const active = p.figures.find((f) => f.id === $activeFigureId && f.canvasId === cid);
      // ops.createFigure stacks vertically by default (below the lowest figure
      // on the canvas — shared with headless compose); the GUI additionally
      // left-aligns with the ACTIVE figure rather than the first.
      const fig = ops.createFigure(p, {
        canvasId: cid!,
        ...(active ? { x: active.x } : {}),
      });
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
  let editing: { kind: "canvas" | "figure" | "layer" | "group"; id: string } | null = null;
  let editVal = "";
  function startRename(kind: "canvas" | "figure" | "layer" | "group", id: string, current: string) {
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
      } else if (kind === "group") {
        ops.renameGroup(p, id, name);
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

  // --- Layers = the derived group tree (groups.ts buildRenderTree), flattened
  // top-z first with depth indents. Collapse state is LOCAL UI state (not
  // model); a collapsed group still drags/toggles as a whole. ---
  type LayerRow =
    | { kind: "el"; key: string; el: Element; depth: number; zTop: number; zBottom: number; dim: boolean }
    | {
        kind: "group";
        key: string;
        def: GroupDef;
        depth: number;
        zTop: number;
        zBottom: number;
        memberIds: string[];
        collapsed: boolean;
        dim: boolean;
      };
  let collapsed: Record<string, boolean> = {};
  function toggleCollapsed(gid: string) {
    collapsed = { ...collapsed, [gid]: !collapsed[gid] };
  }

  function buildRows(fig: Figure, collapsedSet: Record<string, boolean>): LayerRow[] {
    const out: LayerRow[] = [];
    const zIndex = new Map(fig.elements.map((e, i) => [e.id, i]));
    const walk = (nodes: RenderNode[], depth: number, ancestorHidden: boolean) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.kind === "element") {
          const z = zIndex.get(n.el.id) ?? 0;
          out.push({
            kind: "el",
            key: "e:" + n.el.id,
            el: n.el,
            depth,
            zTop: z,
            zBottom: z,
            dim: ancestorHidden || !!n.el.hidden, // effectiveHidden dimming
          });
          continue;
        }
        const members = membersDeep(fig, n.def.id);
        const zs = members.map((m) => zIndex.get(m.id) ?? 0);
        const dim = ancestorHidden || !!n.def.hidden;
        const isCollapsed = !!collapsedSet[n.def.id];
        out.push({
          kind: "group",
          key: "g:" + n.def.id,
          def: n.def,
          depth,
          zTop: zs.length ? Math.max(...zs) : 0,
          zBottom: zs.length ? Math.min(...zs) : 0,
          memberIds: members.map((m) => m.id),
          collapsed: isCollapsed,
          dim,
        });
        if (!isCollapsed) walk(n.children, depth + 1, dim);
      }
    };
    walk(buildRenderTree(fig), 0, false);
    return out;
  }
  $: rows = activeFig ? buildRows(activeFig, collapsed) : [];

  function labelFor(el: Element) {
    if (el.name) return el.name;
    const z = activeFig ? activeFig.elements.findIndex((e) => e.id === el.id) : -1;
    return `${el.type} ${z + 1}`;
  }

  // Select a group row = select its members deep (same as clicking it on canvas).
  function selectGroup(gid: string) {
    if (!activeFig) return;
    const members = membersDeep(activeFig, gid).map((e) => e.id);
    if (!members.length) return;
    selectOnly(members[0]); // clears part/frame selection
    selection.set(new Set(members));
  }
  function groupSelected(row: LayerRow): boolean {
    if (row.kind !== "group") return false;
    return row.memberIds.length > 0 && row.memberIds.every((id) => $selection.has(id));
  }

  // --- Layer visibility / lock toggles (shared ops, one undo each) ---
  function toggleHidden(el: Element) {
    commit((p) => ops.setElementStyle(p, [el.id], { hidden: !el.hidden }));
  }
  function toggleLocked(el: Element) {
    commit((p) => ops.setElementStyle(p, [el.id], { locked: !el.locked }));
  }
  function toggleGroupHidden(def: GroupDef) {
    commit((p) => ops.setGroupState(p, def.id, { hidden: !def.hidden }));
  }
  function toggleGroupLocked(def: GroupDef) {
    commit((p) => ops.setGroupState(p, def.id, { locked: !def.locked }));
  }

  // --- Drag-to-reorder (z-order). Grip pointerdown starts a drag; moving over a
  // row reorders live (one deferred beginGesture → one undo for the whole drag).
  // Group rows move their WHOLE contiguous run (ops.reorderElement is group-
  // aware and snaps any slot that would fragment a run). ---
  let dragKey: string | null = null;
  let dragBegan = false;
  let layersUl: HTMLUListElement;

  function startLayerDrag(e: PointerEvent, row: LayerRow) {
    e.preventDefault();
    e.stopPropagation();
    dragKey = row.key;
    dragBegan = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onLayerDragMove(e: PointerEvent) {
    if (!dragKey || !layersUl) return;
    const rowEls = [...layersUl.querySelectorAll("li.layer")] as HTMLElement[];
    let to = rowEls.length - 1;
    for (let i = 0; i < rowEls.length; i++) {
      const r = rowEls[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        to = i;
        break;
      }
    }
    const cur = rows.findIndex((r) => r.key === dragKey);
    if (cur < 0 || to < 0 || to >= rows.length || to === cur) return;
    const moved = rows[cur];
    const anchor = rows[to];
    // Never drop a group onto one of its own (displayed) descendants.
    if (moved.kind === "group" && anchor.zBottom >= moved.zBottom && anchor.zTop <= moved.zTop) return;
    const k = moved.kind === "group" ? moved.memberIds.length : 1;
    // Display index → post-removal model slot: moving UP places the block just
    // above the anchor row (its indices shift down by k after removal); moving
    // DOWN places it just below (anchor indices unaffected). Flat lists reduce
    // to the old `layers.length - 1 - to` mapping exactly.
    const target = to < cur ? anchor.zTop - k + 1 : anchor.zBottom;
    if (!dragBegan) {
      beginGesture();
      dragBegan = true;
    }
    const fid = $activeFigureId;
    const id = moved.kind === "group" ? moved.def.id : moved.el.id;
    mutate((p) => ops.reorderElement(p, fid!, id, target));
  }
  function endLayerDrag(e: PointerEvent) {
    if (!dragKey) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    dragKey = null;
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
      {#each rows as row (row.key)}
        {#if row.kind === "group"}
          <li
            class="layer grp"
            data-gid={row.def.id}
            class:active={groupSelected(row)}
            class:dragging={dragKey === row.key}
            class:isHidden={row.dim}
            style={`padding-left:${row.depth * 12}px`}
          >
            <button
              class="grip"
              title="Drag to reorder the whole group"
              aria-label="Drag to reorder group"
              on:pointerdown={(e) => startLayerDrag(e, row)}
              on:pointermove={onLayerDragMove}
              on:pointerup={endLayerDrag}
              on:pointercancel={endLayerDrag}
              on:click|preventDefault>⠿</button
            >
            <button
              class="caret"
              title={row.collapsed ? "Expand" : "Collapse"}
              aria-label="Toggle group contents"
              on:click={() => toggleCollapsed(row.def.id)}>{row.collapsed ? "▸" : "▾"}</button
            >
            <button
              class="tog"
              class:muted={row.def.hidden}
              title={row.def.hidden ? "Show group" : "Hide group"}
              aria-label="Toggle group visibility"
              on:click={() => toggleGroupHidden(row.def)}
            >
              {#if row.def.hidden}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.2" /></svg>
              {:else}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><circle cx="8" cy="8" r="1.9" fill="currentColor" /></svg>
              {/if}
            </button>
            <button
              class="tog"
              class:on={row.def.locked}
              title={row.def.locked ? "Unlock group" : "Lock group"}
              aria-label="Toggle group lock"
              on:click={() => toggleGroupLocked(row.def)}
            >
              {#if row.def.locked}
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="currentColor" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
              {:else}
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
              {/if}
            </button>
            {#if editing && editing.kind === "group" && editing.id === row.def.id}
              <input
                class="rename"
                bind:value={editVal}
                use:focusSelect
                on:keydown={onRenameKey}
                on:blur={commitRename} />
            {:else}
              <button
                class="item gname"
                on:click={() => selectGroup(row.def.id)}
                on:dblclick={() => startRename("group", row.def.id, row.def.name)}
                title="Click to select the group · double-click to rename">
                {row.def.name}
              </button>
            {/if}
            <span class="gcount" title="Members (deep)">{row.memberIds.length}</span>
          </li>
        {:else}
          <li
            class="layer"
            class:active={$selection.has(row.el.id)}
            class:dragging={dragKey === row.key}
            class:isHidden={row.dim}
            style={`padding-left:${row.depth * 12}px`}
          >
            <button
              class="grip"
              title="Drag to reorder z-position"
              aria-label="Drag to reorder"
              on:pointerdown={(e) => startLayerDrag(e, row)}
              on:pointermove={onLayerDragMove}
              on:pointerup={endLayerDrag}
              on:pointercancel={endLayerDrag}
              on:click|preventDefault>⠿</button
            >
            <button
              class="tog"
              class:muted={row.el.hidden}
              title={row.el.hidden ? "Show" : "Hide"}
              aria-label="Toggle visibility"
              on:click={() => toggleHidden(row.el)}
            >
              {#if row.el.hidden}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.2" /></svg>
              {:else}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><circle cx="8" cy="8" r="1.9" fill="currentColor" /></svg>
              {/if}
            </button>
            <button
              class="tog"
              class:on={row.el.locked}
              title={row.el.locked ? "Unlock" : "Lock"}
              aria-label="Toggle lock"
              on:click={() => toggleLocked(row.el)}
            >
              {#if row.el.locked}
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="currentColor" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0V7" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
              {:else}
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" /><path d="M5.3 7V5.3a2.7 2.7 0 0 1 5.4 0" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
              {/if}
            </button>
            {#if editing && editing.kind === "layer" && editing.id === row.el.id}
              <input
                class="rename"
                bind:value={editVal}
                use:focusSelect
                on:keydown={onRenameKey}
                on:blur={commitRename} />
            {:else}
              <button
                class="item"
                on:click={() => selectOnly(row.el.id)}
                on:dblclick={() => startRename("layer", row.el.id, labelFor(row.el))}
                title="Click to select · double-click to rename">
                {labelFor(row.el)}
              </button>
            {/if}
            {#if row.el.type === "text" && row.el.panelLabel}
              <span class="plabel" title="Panel label (caption block)">{row.el.text.trim().slice(0, 3) || "¶"}</span>
            {/if}
          </li>
        {/if}
      {/each}
      {#if rows.length === 0}
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
  /* P7 group rows: collapse caret, bold name, member count badge. */
  .caret {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    color: var(--c-tx-muted);
    cursor: pointer;
    padding: 2px 1px;
    font-size: 10px;
    line-height: 1;
    width: 14px;
  }
  .caret:hover {
    color: var(--c-tx-hi);
  }
  .gname {
    font-weight: 600;
  }
  .gcount {
    flex: none;
    margin-right: 6px;
    font-size: 9px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-tx-muted);
    font-variant-numeric: tabular-nums;
  }
  li.active .gcount {
    background: transparent;
    color: var(--c-on-accent);
  }
  li.grp.isHidden .gname {
    opacity: 0.5;
    font-style: italic;
  }
</style>
