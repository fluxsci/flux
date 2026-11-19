<script lang="ts">
  /**
   * Layers and their objects: the X-ray of an image.
   *
   * Every layer is a row (an eye, its kind, how many objects it holds); a layer of objects opens to list them by
   * name with the columns of their table. Hovering a row outlines the object on the image, and hovering an object
   * on the image finds its row. Type to filter. The list owns its keys while this zone is open.
   */
  import { tick } from "svelte";
  import { project } from "../../store";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import { fluximgBundle, fluximgLayerText, fluximgService, needLayerText } from "../store";
  import { objectIndex } from "../layers";
  import { layerSvgPath } from "../static";
  import type { FluximgTable } from "../types";
  import { moveLayer, setLayer, toggleLayer, type LiveContext } from "./actions";
  import { fluximgHover, liveView, setLive, settleLiveEdit } from "./session";

  let { ctx, armed = null }: { ctx: LiveContext; armed?: string | null } = $props();

  const asset = $derived($project.assets.find((a) => a.id === ctx.element.assetId));
  const byId = $derived(new Map(ctx.manifest.layers.map((l) => [l.id, l])));
  /** Top of the stack first, as every layer list reads. */
  const layers = $derived(ctx.view.layers.slice().reverse());
  let open = $state<Record<string, boolean>>({});
  let filter = $state("");
  let filterEl = $state<HTMLInputElement>();
  let listEl = $state<HTMLDivElement>();
  let cursor = $state("");
  let picking = $state(false);
  let optIndex = $state(0);

  // Tables load when a layer is first opened; object lists come from the layer's own shapes (always present).
  let tables = $state.raw<Record<string, FluximgTable | null>>({});
  function needTable(id: string): void {
    const layer = byId.get(id);
    if (!asset || !layer || layer.kind === "intensity" || !layer.table || id in tables) return;
    tables = { ...tables, [id]: null };
    void fluximgService().table(fluximgBundle(asset), layer.table).then((t) => { tables = { ...tables, [id]: t }; }, () => {});
  }
  $effect(() => { if (asset) for (const l of layers) { const p = layerSvgPath(byId.get(l.id)); if (p && open[l.id]) { needLayerText(asset, p); needTable(l.id); } } });
  // A single object layer opens by itself: its objects are what the zone is for.
  $effect(() => { const objs = layers.filter((l) => l.kind !== "intensity"); if (objs.length === 1 && open[objs[0].id] === undefined) open = { ...open, [objs[0].id]: true }; });

  const CAP = 400;
  interface ObjectRow { kind: "object"; id: string; layerId: string; key: string; cells: Array<[string, string]> }
  interface LayerRow { kind: "layer"; id: string; layerId: string }
  interface MoreRow { kind: "more"; id: string; layerId: string; count: number }
  type Row = LayerRow | ObjectRow | MoreRow;

  const cell = (v: unknown): string => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)))) : v === null || v === undefined ? "–" : String(v));
  function objectsOf(id: string): ObjectRow[] {
    const layer = byId.get(id), path = layerSvgPath(layer);
    if (!asset || !layer || !path) return [];
    const text = $fluximgLayerText[`${asset.id}|${path}`];
    if (text === undefined) return [];
    let index;
    try { index = objectIndex(text); } catch { return []; }
    const table = tables[id] ?? null;
    const keyCol = table ? table.columns[table.key] : null;
    const rowOf = new Map<string, number>();
    if (keyCol) keyCol.forEach((v, i) => rowOf.set(String(v), i));
    const names = table ? Object.keys(table.columns).filter((c) => c !== table.key && c !== "label") : [];
    return index.map((o) => {
      const r = rowOf.get(o.key);
      const cells: Array<[string, string]> = r === undefined ? [] : names.map((c) => [c, cell(table!.columns[c][r])]);
      return { kind: "object" as const, id: `obj:${id}/${o.key}`, layerId: id, key: o.key, cells };
    });
  }
  const needle = $derived(filter.trim().toLowerCase());
  const rows = $derived.by(() => {
    const out: Row[] = [];
    for (const l of layers) {
      out.push({ kind: "layer", id: `layer:${l.id}`, layerId: l.id });
      if (l.kind === "intensity" || !(open[l.id] || needle)) continue;
      let objs = objectsOf(l.id);
      if (needle) objs = objs.filter((o) => o.key.toLowerCase().includes(needle) || o.cells.some(([, v]) => v.toLowerCase().includes(needle)));
      for (const o of objs.slice(0, CAP)) out.push(o);
      if (objs.length > CAP) out.push({ kind: "more", id: `more:${l.id}`, layerId: l.id, count: objs.length - CAP });
    }
    return out;
  });
  $effect(() => { if (!rows.some((r) => r.id === cursor)) cursor = rows[0]?.id ?? ""; });
  const current = $derived(rows.find((r) => r.id === cursor) ?? null);
  const currentLayer = $derived(current ? ctx.view.layers.find((l) => l.id === current.layerId) ?? null : null);
  const namesOn = (id: string): boolean => !!ctx.view.furniture.names && ctx.view.furniture.names.layers.includes(id);

  function toggleNames(id: string): void {
    const n = ctx.view.furniture.names;
    const all = ctx.manifest.layers.filter((l) => l.kind !== "intensity").map((l) => l.id);
    const now = n ? n.layers : [];
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    liveView(`names:${id}`, { furniture: { names: next.length ? { layers: all.filter((x) => next.includes(x)) } : null } as never });
    settleLiveEdit();
  }
  const COLORS: Array<{ label: string; color: string | null }> = [
    { label: "its own", color: null }, { label: "white", color: "#ffffff" }, { label: "yellow", color: "#ffd500" }, { label: "cyan", color: "#00e5ff" },
    { label: "magenta", color: "#ff3df2" }, { label: "green", color: "#3dff6e" }, { label: "orange", color: "#ff8a1f" }, { label: "red", color: "#ff3b30" },
  ];
  function pickColor(i: number): void {
    if (!current) return;
    setLayer(current.layerId, { color: COLORS[i].color as never }, `layer-color:${current.layerId}`);
    settleLiveEdit();
    picking = false;
  }

  function hover(r: Row | null): void {
    if (r && r.kind === "object") fluximgHover.set({ layerId: r.layerId, key: r.key, from: "list" });
    else if ($fluximgHover?.from === "list") fluximgHover.set(null);
  }
  // An object hovered ON THE IMAGE finds its row: open its layer and bring the row into view.
  $effect(() => {
    const h = $fluximgHover;
    if (!h || h.from !== "image") return;
    if (!open[h.layerId]) open = { ...open, [h.layerId]: true };
    void tick().then(() => listEl?.querySelector(`[data-rid="${CSS.escape(`obj:${h.layerId}/${h.key}`)}"]`)?.scrollIntoView({ block: "nearest" }));
  });
  function move(by: number): void {
    const i = Math.max(0, rows.findIndex((r) => r.id === cursor)), next = rows[Math.min(rows.length - 1, Math.max(0, i + by))];
    if (!next) return;
    cursor = next.id;
    hover(next);
    void tick().then(() => listEl?.querySelector(`[data-rid="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function onKey(e: KeyboardEvent): void {
    if (yieldsToShellModal(e) || isAnnotateChord(e) || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const typing = e.target === filterEl;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = (): void => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (typing) {
      // The filter keeps its letters; the arrows still walk the list, and Enter hands the keyboard back.
      if (k === "ArrowDown") { done(); move(1); } else if (k === "ArrowUp") { done(); move(-1); }
      else if (k === "Enter") { done(); filterEl?.blur(); }
      else if (k === "Escape" && filter) { done(); filter = ""; }
      else if (k !== "Escape") e.stopImmediatePropagation();
      return;
    }
    if (k === "Escape") { if (picking) { done(); picking = false; } return; } // otherwise the panel backs out
    if (picking) {
      if (/^[1-9]$/.test(k) && Number(k) <= COLORS.length) { done(); pickColor(Number(k) - 1); return; }
      if (k === "ArrowRight" || k === "ArrowDown") { done(); optIndex = (optIndex + 1) % COLORS.length; return; }
      if (k === "ArrowLeft" || k === "ArrowUp") { done(); optIndex = (optIndex + COLORS.length - 1) % COLORS.length; return; }
      if (k === "Enter" || k === " ") { done(); pickColor(optIndex); return; }
      done(); return;
    }
    const id = current?.layerId;
    switch (k) {
      case "ArrowDown": case "s": done(); if (e.shiftKey && id) moveLayer(id, -1); else move(1); return;
      case "ArrowUp": case "w": done(); if (e.shiftKey && id) moveLayer(id, 1); else move(-1); return;
      case "ArrowRight": case "ArrowLeft": case "Enter": case " ":
        done();
        if (current?.kind === "layer" && currentLayer?.kind !== "intensity") open = { ...open, [current.layerId]: k === "ArrowRight" ? true : k === "ArrowLeft" ? false : !open[current.layerId] };
        return;
      case "x": done(); if (id) toggleLayer(id); return;
      case "e": done(); if (id) setLive({ armed: armed === `layer:${id}` ? null : `layer:${id}` }); return;
      case "q": done(); if (id && currentLayer?.kind !== "intensity") toggleNames(id); return;
      case "c": done(); if (id) { picking = true; optIndex = Math.max(0, COLORS.findIndex((o) => o.color === (currentLayer?.color ?? null))); } return;
      case "a": done(); void tick().then(() => filterEl?.focus()); return;
    }
    if (k.length === 1 && k !== "r" && k !== "f") done(); // the zone owns stray letters
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="search-row" class:active={!!filter}>
  <span class="hk">a</span>
  <input bind:this={filterEl} bind:value={filter} class="search-in" placeholder="Filter objects by name or value…" spellcheck="false" />
</div>
<div class="list scrolls" bind:this={listEl} role="tree" tabindex="-1" aria-label="Layers and objects" onpointerleave={() => hover(null)}>
  {#each rows as r (r.id)}
    {#if r.kind === "layer"}
      {@const L = ctx.view.layers.find((l) => l.id === r.layerId)!}
      {@const layer = byId.get(r.layerId)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
      <div class="lrow" class:sel={r.id === cursor} class:hidden={!L.visible} class:armed={armed === `layer:${L.id}`} role="treeitem" tabindex="-1" aria-selected={r.id === cursor} data-rid={r.id}
        onclick={() => { cursor = r.id; if (L.kind !== "intensity") open = { ...open, [L.id]: !open[L.id] }; }} onpointerenter={() => hover(null)}>
        <span class="tw">{L.kind === "intensity" ? "" : open[L.id] || needle ? "▾" : "▸"}</span>
        <button class="eye" onclick={(e) => { e.stopPropagation(); toggleLayer(L.id); }} title={L.visible ? "Hide this layer" : "Show this layer"} aria-label={L.visible ? `Hide ${L.name}` : `Show ${L.name}`}>{L.visible ? "◉" : "○"}</button>
        <span class="rlabel">{L.name}</span>
        <span class="tag">{L.kind === "labels" ? "objects" : L.kind === "vector" ? "shapes" : "image"}</span>
        {#if L.color ?? layer?.color}<span class="sw" style={`background:${L.color ?? layer?.color}`}></span>{/if}
        {#if namesOn(L.id)}<span class="tag on">names</span>{/if}
        <span class="count">{layer && layer.kind !== "intensity" ? layer.count.toLocaleString("en-US") : ""}</span>
        <span class="pct">{Math.round(L.opacity * 100)}%</span>
      </div>
    {:else if r.kind === "object"}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
      <div class="lrow obj" class:sel={r.id === cursor} class:hot={$fluximgHover?.layerId === r.layerId && $fluximgHover?.key === r.key} role="treeitem" tabindex="-1" aria-selected={r.id === cursor} data-rid={r.id}
        onclick={() => { cursor = r.id; }} onpointerenter={() => hover(r)}>
        <span class="rlabel mono">{r.key}</span>
        <span class="cells">{#each r.cells.slice(0, 3) as [name, value] (name)}<span class="cellk">{name}</span> {value}&ensp;{/each}</span>
      </div>
    {:else}
      <div class="lrow more" data-rid={r.id}><span class="rlabel">{r.count.toLocaleString("en-US")} more: filter to narrow the list</span></div>
    {/if}
  {/each}
  {#if !rows.length}<div class="empty">No layers in this image</div>{/if}
</div>
<!-- A fixed strip, so the panel never changes height as the pointer moves. -->
<div class="detail">
  {#if picking && current}
    <span class="opts" role="listbox" aria-label="Layer colour">
      {#each COLORS as o, i (o.label)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <span class="opt" class:cur={i === optIndex} role="option" tabindex="-1" aria-selected={i === optIndex} onpointerenter={() => (optIndex = i)} onclick={() => pickColor(i)}><span class="ok hk">{i + 1}</span>{#if o.color}<span class="sw" style={`background:${o.color}`}></span>{/if}{o.label}</span>
      {/each}
    </span>
  {:else if current?.kind === "object"}
    <span class="dk">{current.key}</span>{#each current.cells as [name, value] (name)}<span class="dcell"><span class="cellk">{name}</span> {value}</span>{/each}
  {:else if currentLayer}
    <span class="dk">{currentLayer.name}</span>
    <span class="dcell">{currentLayer.kind === "labels" ? "objects with outlines and a table" : currentLayer.kind === "vector" ? "vector shapes" : "an intensity image laid over the pixels"}</span>
  {/if}
</div>
<div class="foot2">
  <span><b class="hk">↑↓</b> walk</span><span><b class="hk">x</b> show</span><span><b class="hk">e</b> opacity{armed?.startsWith("layer:") ? " ↕" : ""}</span><span><b class="hk">c</b> colour</span>
  <span><b class="hk">q</b> names</span><span><b class="hk">⇧↑↓</b> reorder</span><span><b class="hk">esc</b> back</span>
</div>

<style>
  .hk { color: var(--c-accent); min-width: 17px; height: 16px; }
  .search-row { display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 4px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--c-bg); margin-bottom: 6px; }
  .search-row.active { border-color: var(--c-accent); }
  .search-in { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--c-tx); font: 12.5px var(--font-serif); padding: 0; }
  .list { max-height: min(46vh, 380px); min-height: 96px; overflow-y: auto; border-top: 1px solid var(--c-line); border-bottom: 1px solid var(--c-line); }
  /* The X-ray's row: 24 px, a twisty, an eye, the name, then quiet context at the right. */
  .lrow { display: flex; align-items: center; gap: 7px; height: 24px; padding: 0 6px 0 4px; cursor: var(--cursor-cross-hover); white-space: nowrap; }
  .lrow.obj { padding-left: 44px; gap: 10px; }
  .lrow.more { padding-left: 44px; cursor: default; color: var(--c-tx-muted); font: 11px var(--font-ui); }
  .lrow:not(.more):hover { background: var(--c-surface-2); }
  .lrow.sel, .lrow.armed { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); }
  .lrow.hot { background: color-mix(in oklab, var(--c-accent-bright) 18%, transparent); }
  .tw { width: 12px; color: var(--c-tx-muted); font: 9px var(--font-mono); text-align: center; flex: none; }
  .eye { width: 16px; height: 20px; padding: 0; border: 0; background: none; color: var(--c-tx-2); font: 12px var(--font-mono); cursor: var(--cursor-cross-hover); flex: none; }
  .eye:hover { color: var(--c-tx-hi); }
  .rlabel { color: var(--c-tx); overflow: hidden; text-overflow: ellipsis; }
  .rlabel.mono { font: 11.5px var(--font-mono); color: var(--c-tx-hi); flex: none; max-width: 150px; }
  .lrow.hidden .rlabel { opacity: 0.45; text-decoration: line-through; }
  .tag { font: 9.5px var(--font-mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--c-tx-muted); flex: none; }
  .tag.on { color: var(--c-accent-bright); }
  .sw { display: inline-block; width: 11px; height: 11px; border-radius: 3px; border: 1px solid color-mix(in oklab, var(--c-tx-hi) 22%, transparent); box-sizing: border-box; flex: none; }
  .count, .pct { font: 11px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-muted); flex: none; }
  .count { margin-left: auto; }
  .pct { width: 36px; text-align: right; color: var(--c-tx-2); }
  .cells { font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); overflow: hidden; text-overflow: ellipsis; }
  .cellk { color: var(--c-tx-muted); }
  .empty { color: var(--c-tx-muted); padding: 14px; text-align: center; font: 11.5px var(--font-ui); }
  .detail { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 2px 12px; height: 46px; overflow: hidden; padding: 6px 2px 0; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--c-tx-2); }
  .dk { color: var(--c-tx-hi); }
  .dcell { white-space: nowrap; }
  .opts { display: flex; flex-wrap: wrap; gap: 3px; }
  .opt { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 6px 0 3px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx-2); cursor: var(--cursor-cross-hover); font: 11px var(--font-serif); white-space: nowrap; }
  .opt .ok { min-width: 14px; height: 13px; padding: 0 2px; font-size: 9px; line-height: 11px; }
  .opt.cur { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .foot2 { display: flex; flex-wrap: wrap; gap: 4px 12px; padding-top: 6px; font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  .foot2 span { display: inline-flex; align-items: center; gap: 4px; }
</style>
