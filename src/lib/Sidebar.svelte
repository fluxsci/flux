<script lang="ts">
  import { onMount, tick } from "svelte";
  import { editSession } from "./interact/editSession";
  import {
    project,
    activeFigureId,
    activeCanvasId,
    selection,
    partSelection,
    selectedFrameId,
    commit,
    mutate,
    mutateFigure,
    figureRev,
    globalRev,
    addCanvas,
    setActiveCanvas,
    figureSelection,
    selectedFigureIds,
    figNamer,
    figureCatalog,
  } from "./store";
  import { requestFigureDeletion } from "./project/figureDeletion";
  import { familyById, shortBadge } from "./figfamily";
  import type { Element, GroupDef } from "./types";
  import * as ops from "./ops";
  import { effectiveLocked, effectiveHidden } from "./groups";
  import { deriveLayerRows, type LayerRow } from "./figure/derived/layerRows";
  import { perfCounters } from "./dev/perfCounters";
  import VirtualFixedList from "./ui/VirtualFixedList.svelte";
  import { centerOnFigure } from "./viewportNav";

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

  function deleteFigure(id: string) { void requestFigureDeletion("figure", id); }

  // M11: inline rename (no blocking native window.prompt). Double-click a row to
  // edit; Enter / blur commits, Esc cancels. Figures are the exception since
  // figure families landed: their name is DERIVED (family + number), so the
  // double-click opens the Figure Namer (Ctrl+R) instead of a text field.
  let editing: { kind: "canvas" | "layer" | "group"; id: string } | null = null;
  let editVal = "";
  function startRename(kind: "canvas" | "layer" | "group", id: string, current: string) {
    editing = { kind, id };
    editVal = current;
  }
  function openNamer(figId: string) {
    activeFigureId.set(figId); // name what the user is looking at
    figNamer.set({ figId });
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
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") cancelRename();
  }

  /** Clicking a figure name goes to it: activate, and bring it into view at the
   *  zoom the user is already working at. Re-clicking the active figure
   *  re-centres it (the store's same-value set wouldn't notify, so this is a
   *  direct call, not a subscriber) — which makes the row a "put me back" button
   *  after panning away.
   *
   *  With a modifier it is a LIST pick instead (for reordering, below), so the
   *  view stays put: Shift extends a range from the active row, Ctrl/Cmd
   *  toggles one row in or out. */
  function goToFigure(id: string, e: MouseEvent) {
    if (figDragMoved) return; // this click ended a reorder drag, not a click
    if (e.shiftKey) {
      selectFigureRange(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      toggleFigureRow(id);
      return;
    }
    figureSelection.set(new Set([id]));
    activeFigureId.set(id);
    centerOnFigure(id);
  }

  /** Shift+click: every row between the active one and this one. The anchor is
   *  the active figure (not a separate "last clicked" state) so what the range
   *  runs from is always visible. */
  function selectFigureRange(id: string) {
    const ids = canvasFigures.map((f) => f.id);
    const a = ids.indexOf($activeFigureId ?? "");
    const b = ids.indexOf(id);
    if (b < 0) return;
    const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
    figureSelection.set(new Set(ids.slice(lo, hi + 1)));
  }

  /** Ctrl/Cmd+click: add or remove one row. Removing the active row leaves the
   *  active figure alone — it is what the canvas shows, not a list pick. */
  function toggleFigureRow(id: string) {
    const next = new Set($figureSelection);
    // An empty pick means "just the active figure" (store contract): make that
    // implicit member explicit before adding to it, or Ctrl+click would read as
    // a plain click that dropped it.
    if (!next.size && $activeFigureId) next.add($activeFigureId);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      activeFigureId.set(id);
    }
    figureSelection.set(next);
  }

  /** Is this row part of what a reorder would move? (An empty pick = the
   *  active figure.) */
  function rowPicked(id: string, sel: Set<string>, active: string | null): boolean {
    return sel.size ? sel.has(id) : id === active;
  }

  // Figures on the active canvas only — in the model's order, which IS the
  // list order the user can now drag (see the figure-reorder block below).
  $: canvasFigures = $project.figures.filter((f) => f.canvasId === $activeCanvasId);
  $: activeFig = $project.figures.find((f) => f.id === $activeFigureId) ?? null;

  // --- Drag-to-reorder the Figures list. The list order IS the model order
  // (planFigSave numbers `order` from it, so it persists), and reordering is
  // ORDER ONLY: x/y never move, so a figure stays exactly where it sits on the
  // canvas, and family/number stay put — renumbering remains the namer's
  // deliberate act (Ctrl+R). Alt+↑/↓ does the same from the keyboard
  // (keyboard.ts), on the same picked rows.
  //
  // Unlike a Layers row (which has a grip, because its body is a click target
  // for select/rename), the WHOLE figure row is the drag surface — it is one
  // block. So the press only becomes a drag past a small threshold, and the
  // click that ends a real drag is suppressed rather than treated as
  // "go to this figure". Pointer capture is claimed at that same threshold,
  // never on a plain click, so a click keeps landing on the button it hit.
  //
  // A drag carries the whole PICK (one row, or several picked with
  // Shift/Ctrl+click) — dragging a row that is not part of the pick makes it
  // the pick first, the file-manager rule. ---
  const FIG_DRAG_SLOP = 4; // px of movement before a press is a drag
  let figListEl: HTMLUListElement | undefined;
  let figDragIds: string[] = []; // rows being dragged (drives .dragging)
  let figDragFrom: { id: string; x: number; y: number } | null = null;
  let sidebarEl: HTMLElement;
  const reorderSession = editSession();
  let capture: { node: HTMLElement; id: number } | null = null;
  function capturePointer(e: PointerEvent) {
    const node = sidebarEl;
    try { node.setPointerCapture(e.pointerId); capture = { node, id: e.pointerId }; } catch { /* synthetic gate */ }
  }
  function releasePointer() {
    const c = capture; capture = null;
    try { if (c) c.node.releasePointerCapture(c.id); } catch { /* already lost */ }
  }
  function cancelReorder() {
    const active = !!figDragFrom || !!dragKey;
    if (!active) return false;
    reorderSession.cancel();
    figDragFrom = null; figDragIds = []; figDragMoved = true;
    dragKey = null; dragBegan = false;
    releasePointer();
    return true;
  }
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cancelReorder()) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancelReorder);
    return () => { cancelReorder(); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancelReorder); };
  });
  let figDragMoved = false; // a drag happened → swallow its trailing click

  /** Index of the figure row under `y` (rows are keyed, so live reordering
   *  keeps these rects in step with the model). */
  function figRowIndexAtY(y: number): number {
    const rows = [...(figListEl?.children ?? [])] as HTMLElement[];
    for (let i = 0; i < rows.length; i++) {
      if (y < rows[i].getBoundingClientRect().bottom) return i;
    }
    return rows.length - 1;
  }

  function startFigDrag(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    figDragFrom = { id, x: e.clientX, y: e.clientY };
    figDragMoved = false;
  }
  function onFigDragMove(e: PointerEvent) {
    if (!figDragFrom) return;
    if (!figDragIds.length) {
      const far =
        Math.abs(e.clientY - figDragFrom.y) >= FIG_DRAG_SLOP ||
        Math.abs(e.clientX - figDragFrom.x) >= FIG_DRAG_SLOP;
      if (!far) return;
      const grabbed = figDragFrom.id;
      // Grabbing a row outside the pick re-picks it (and only it).
      if (!rowPicked(grabbed, $figureSelection, $activeFigureId)) {
        figureSelection.set(new Set([grabbed]));
        activeFigureId.set(grabbed);
      }
      figDragIds = selectedFigureIds($project, $activeCanvasId);
      if (!figDragIds.length) return;
      figDragMoved = true;
      capturePointer(e);
    }
    // Where the block's first row should land: above the pointer row when
    // dragging up, and with its LAST row on the pointer row when dragging down
    // (the block is contiguous after the first move, so the rows before it are
    // exactly the non-moving ones ops.reorderFigures counts).
    const ids = figDragIds;
    const rowIds = canvasFigures.map((f) => f.id);
    const first = rowIds.findIndex((id) => ids.includes(id));
    const over = figRowIndexAtY(e.clientY);
    if (first < 0 || over < 0) return;
    const at = over < first ? over : over - ids.length + 1;
    if (at === first) return;
    reorderSession.run(() => mutate((p) => ops.reorderFigures(p, ids, at)));
  }
  function endFigDrag(_e: PointerEvent) {
    reorderSession.finish();
    figDragFrom = null;
    figDragIds = [];
    releasePointer();
  }

  // --- Layers = the derived group tree, flattened top-z first with depth
  // indents (pure selector: figure/derived/layerRows.ts — WS-1 Fix 6a).
  // Collapse state is LOCAL UI state (not model); a collapsed group still
  // drags/toggles as a whole. ---
  let collapsed: Record<string, boolean> = {};
  function toggleCollapsed(gid: string) {
    collapsed = { ...collapsed, [gid]: !collapsed[gid] };
  }
  // WS-1 Fix 7: hidden keep-alive pane — freeze rows (see Canvas paneActive).
  export let paneActive = true;

  // WS-1 Fix 4: rows rebuild only when the ACTIVE figure's revision (or a
  // global/unscoped commit, or collapse state) changes — not on every project
  // notify. Memo lives in a non-reactive const box (see Canvas effMemoBox note).
  const rowsMemoBox = { key: "", val: [] as LayerRow[], collapsed: null as unknown, collapsedGen: 0 };
  $: rows = (() => {
    if (!paneActive) return rowsMemoBox.val;
    if (!activeFig) return [];
    if (collapsed !== rowsMemoBox.collapsed) {
      rowsMemoBox.collapsed = collapsed;
      rowsMemoBox.collapsedGen++;
    }
    const key = `${activeFig.id}|${$figureRev[activeFig.id] ?? 0}|${$globalRev}|${rowsMemoBox.collapsedGen}`;
    if (key === rowsMemoBox.key) return rowsMemoBox.val;
    perfCounters.rowsRecomputes++;
    rowsMemoBox.key = key;
    rowsMemoBox.val = deriveLayerRows(activeFig, collapsed);
    return rowsMemoBox.val;
  })();

  // WS-1 Fix 6b: fixed layer-row height (px) — the windowing grid. Matches the
  // measured natural height of a row pre-virtualization; .layer pins it in CSS.
  const LAYER_ROW_H = 25;

  function labelFor(el: Element) {
    if (el.name) return el.name;
    const z = activeFig ? activeFig.elements.findIndex((e) => e.id === el.id) : -1;
    return `${el.type} ${z + 1}`;
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
  let vlist: VirtualFixedList<LayerRow> | undefined;

  function startLayerDrag(e: PointerEvent, row: LayerRow) {
    e.preventDefault();
    e.stopPropagation();
    dragKey = row.key;
    dragBegan = false;
    capturePointer(e);
  }
  function onLayerDragMove(e: PointerEvent) {
    if (!dragKey || !vlist) return;
    // Logical index from pointer Y + scrollTop via the fixed row height (WS-1
    // Fix 6d), off-window rows included. The old per-row rect scan anchored on
    // the first row whose MIDPOINT sat below the pointer — band-lookup at
    // y + rowH/2 reproduces that boundary exactly.
    const to = vlist.indexAtY(e.clientY + LAYER_ROW_H / 2);
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
      dragBegan = true;
    }
    const fid = $activeFigureId;
    const id = moved.kind === "group" ? moved.def.id : moved.el.id;
    // WS-1 Fix 3c: scoped notify — the live reorder preview re-derives only
    // this figure's rows/culling, not the whole project per pointermove.
    reorderSession.run(() => mutateFigure(fid!, (p) => ops.reorderElement(p, fid!, id, target)));
  }
  function endLayerDrag(_e: PointerEvent) {
    reorderSession.finish();
    dragKey = null;
    dragBegan = false;
    releasePointer();
  }
  let layerAnchor: string | null = null;
  const rowIds = (row: LayerRow) => row.kind === "group" ? row.memberIds : [row.el.id];
  function selectLayer(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, row: LayerRow) {
    const ids = rowIds(row);
    if (!ids.length) return;
    const additive = e.ctrlKey || e.metaKey;
    const next = additive ? new Set($selection) : new Set<string>();
    const anchor = rows.findIndex(r => r.key === layerAnchor);
    const index = rows.findIndex(r => r.key === row.key);
    if (e.shiftKey && anchor >= 0) {
      for (const r of rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1))
        for (const id of rowIds(r)) next.add(id);
    } else {
      const remove = additive && ids.every(id => next.has(id));
      for (const id of ids) { if (remove) next.delete(id); else next.add(id); }
      layerAnchor = row.key;
    }
    partSelection.set(null);
    selectedFrameId.set(null);
    selection.set(next);
  }
  async function onLayerKey(e: KeyboardEvent, row: LayerRow) {
    const index = rows.findIndex(r => r.key === row.key);
    let next = index;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && row.kind === "group") {
      collapsed = { ...collapsed, [row.def.id]: e.key === "ArrowLeft" };
    } else if (e.key === "F2") {
      row.kind === "group" ? startRename("group", row.def.id, row.def.name) : startRename("layer", row.el.id, labelFor(row.el));
    } else return;
    e.preventDefault(); e.stopPropagation();
    if (next !== index) {
      const target = rows[next];
      layerAnchor ??= row.key;
      selectLayer(e, target);
      vlist?.ensureVisible(next);
      await tick();
      document.querySelector<HTMLElement>(`[data-layer-key="${CSS.escape(target.key)}"] .item`)?.focus();
    }
  }
  let lastSelected = "";
  $: {
    const id = $selection.values().next().value ?? "";
    if (id !== lastSelected) {
      lastSelected = id;
      const index = rows.findIndex(row => rowIds(row).includes(id));
      if (index >= 0 && !dragKey) vlist?.ensureVisible(index);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="sidebar" bind:this={sidebarEl}
  on:pointermove={(e) => { if (figDragFrom) onFigDragMove(e); else onLayerDragMove(e); }}
  on:pointerup={(e) => { if (figDragFrom) endFigDrag(e); else endLayerDrag(e); }}
  on:pointercancel={cancelReorder} on:lostpointercapture={cancelReorder}>
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
            <button class="del" on:click={() => requestFigureDeletion("canvas", canvas.id)} title="Delete canvas">×</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <div class="head">
      <h4>Figures</h4>
      <button class="mini" on:click={() => figureCatalog.set({})} title="All project figures, references, sources and usages">All…</button>
      <button class="mini" on:click={addFigure} title="Add figure">+</button>
    </div>
    <ul bind:this={figListEl}>
      {#each canvasFigures as fig (fig.id)}
        <li
          class="figrow"
          data-fig-id={fig.id}
          class:active={$activeFigureId === fig.id}
          class:picked={$figureSelection.has(fig.id)}
          class:dragging={figDragIds.includes(fig.id)}
          on:pointerdown={(e) => startFigDrag(e, fig.id)}>
          <span class="fnum" title={fig.name}>{shortBadge(familyById(fig.family, $project.figureFamilies), fig.number ?? 0)}</span>
          <button
            class="item"
            on:click={(e) => goToFigure(fig.id, e)}
            on:dblclick={() => openNamer(fig.id)}
            title={`${fig.name} · @${fig.referenceKey ?? ""}\nClick to go to it · Shift/Ctrl+click to pick several · drag to reorder on this canvas · double-click to rename (Ctrl+R)`}>
            {fig.nickname || fig.name}
          </button>
          <button class="del" on:click={() => deleteFigure(fig.id)} title="Delete figure">×</button>
        </li>
      {/each}
    </ul>
  </section>

  <section class="layers">
    <h4>Layers</h4>
    <!-- WS-1 Fix 6b: fixed-height windowed list — only the viewport ± overscan
         rows exist in the DOM (was: every row, ~5k li at scale). Row markup
         and semantics are unchanged; the <aside> stays the scroll container. -->
    {#if rows.length === 0}
      <ul><li class="empty">No elements yet</li></ul>
    {:else}
      <VirtualFixedList
        bind:this={vlist}
        items={rows}
        rowHeight={LAYER_ROW_H}
        overscan={10}
        getKey={(r) => r.key}
        anchorSuspended={dragKey !== null}
        let:item={row}>
        {#if row.kind === "group"}
          <li
            class="layer grp"
            data-layer-key={row.key}
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
                on:click={(e) => selectLayer(e, row)}
                on:keydown={(e) => onLayerKey(e, row)}
                on:dblclick={() => startRename("group", row.def.id, row.def.name)}
                title="Click to select the group · double-click to rename">
                {row.def.name}
              </button>
            {/if}
            <span class="gcount" title="Members (deep)">{row.memberIds.length}</span>
          </li>
        {:else}
          {@const inheritedLock = !!activeFig && !row.el.locked && effectiveLocked(activeFig, row.el)}
          {@const inheritedHide = !!activeFig && !row.el.hidden && effectiveHidden(activeFig, row.el)}
          <li
            class="layer"
            data-layer-key={row.key}
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
              on:click|preventDefault>⠿</button
            >
            <button
              class="tog"
              class:muted={row.el.hidden}
              disabled={inheritedHide}
              title={inheritedHide ? "Hidden by a parent group — show that group first" : row.el.hidden ? "Show" : "Hide"}
              aria-label="Toggle visibility"
              on:click={() => toggleHidden(row.el)}
            >
              {#if row.el.hidden || inheritedHide}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.2" /></svg>
              {:else}
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.1" /><circle cx="8" cy="8" r="1.9" fill="currentColor" /></svg>
              {/if}
            </button>
            <button
              class="tog"
              class:on={row.el.locked || inheritedLock}
              disabled={inheritedLock}
              title={inheritedLock ? "Locked by a parent group — unlock that group to edit" : row.el.locked ? "Unlock" : "Lock"}
              aria-label="Toggle lock"
              on:click={() => toggleLocked(row.el)}
            >
              {#if row.el.locked || inheritedLock}
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
                on:click={(e) => selectLayer(e, row)}
                on:keydown={(e) => onLayerKey(e, row)}
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
      </VirtualFixedList>
    {/if}
  </section>
</aside>

<style>
  .sidebar {
    /* Width var set by the host mode (FigureMode drag-resize); the fallback
       keeps standalone/demo mounts at the shipped width. */
    width: var(--sb-w, 200px);
    flex: 0 0 var(--sb-w, 200px);
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
  button:focus-visible { outline: 2px solid var(--c-accent); outline-offset: -2px; }
  li.active button:focus-visible { outline-color: var(--c-on-accent); }
  li:hover:not(.active) {
    background: var(--c-surface-2);
  }
  /* Figure rows are draggable as a block (list order = figure order). */
  .figrow {
    cursor: grab;
    touch-action: none; /* a touch drag reorders instead of scrolling the rail */
  }
  /* Picked for a reorder (multi-select): visible without stealing the
     active-figure accent, which means something else. */
  .figrow.picked:not(.active) {
    background: var(--c-accent-tint);
  }
  .figrow.dragging {
    cursor: grabbing;
    box-shadow: inset 0 0 0 1px var(--c-accent);
  }
  .figrow.dragging .item {
    cursor: grabbing;
  }
  /* M14: order-derived figure number (always reflects position, never stale). */
  .fnum {
    flex: 0 0 auto;
    min-width: 18px; /* family badges run wider: "S2" / "ED3" / "M1" */
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
    /* WS-1 Fix 6b: the windowing grid needs a FIXED row height (spacer math +
       logical drag targeting). 25px = the measured natural height pre-virtualization. */
    height: var(--vrow-h, 25px);
    box-sizing: border-box;
    overflow: hidden;
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
