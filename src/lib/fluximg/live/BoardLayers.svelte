<script lang="ts">
  /**
   * Layers and their objects on the board: the X-ray of an image.
   *
   * Every layer is a row with a lamp in its own colour (click: show or hide), its name and how many objects it
   * holds; a layer of objects opens to list them by name with the first columns of their table. Hovering a row
   * lights the object on the image, and hovering an object on the image finds its row. A layer's opacity is the
   * small dial on its row (roll the wheel over it, or drag it sideways). Type in the field to filter. The card
   * walks by keyboard once it has the keys (`d`): the board hands them over and takes them back. Working it with
   * the mouse never takes the keyboard (the board's keys must keep working after a click on a lamp).
   */
  import { tick } from "svelte";
  import { get } from "svelte/store";
  import { project } from "../../store";
  import { fluxFigMenuOpen } from "../../settings";
  import { yieldsToShellModal, isAnnotateChord } from "../../../shell/agent/annotationVisibility";
  import { fluximgLayerText, needLayerText } from "../store";
  import { objectIndex } from "../layers";
  import { layerSvgPath } from "../static";
  import { cellText, fluximgTables, needTable, tableOf } from "./objectTables";
  import PaperKey from "./PaperKey.svelte";
  import BoardStyle from "./BoardStyle.svelte";
  import { DEFAULT_PALETTE, cachedObjectStyles } from "../objectStyle";
  import { fluximgLutsReady, resolveLut } from "../store";
  import { cycleFurnitureCorner, moveLayer, setLayer, toggleFurniture, toggleLayer, type LiveContext } from "./actions";
  import { armLive, cancelLiveEdit, fluximgHover, liveView, settleLiveEdit } from "./session";

  let { ctx, armed = null, width = 228, maxHeight = 420, keys = false, onkeys, onnatural = undefined }: {
    ctx: LiveContext;
    armed?: string | null;
    width?: number;
    maxHeight?: number;
    /** The card has the keyboard. */
    keys?: boolean;
    onkeys: (on: boolean) => void;
    /** The height the card would take with every row showing (the board gives it what room there is). */
    onnatural?: ((height: number) => void) | undefined;
  } = $props();

  const asset = $derived($project.assets.find((a) => a.id === ctx.element.assetId));
  const byId = $derived(new Map(ctx.manifest.layers.map((l) => [l.id, l])));
  /** Top of the stack first, as every layer list reads. */
  const layers = $derived(ctx.view.layers.slice().reverse());
  const hasObjects = $derived(layers.some((l) => l.kind !== "intensity"));
  const stylable = $derived(ctx.manifest.layers.some((l) => l.kind === "labels" || (l.kind === "vector" && !!l.table)));
  const styledAny = $derived(ctx.view.layers.some((l) => l.visible && !!l.styleBy));
  let open = $state<Record<string, boolean>>({});
  let filter = $state("");
  let filterEl = $state<HTMLInputElement>();
  let listEl = $state<HTMLDivElement>();
  let cursor = $state("");
  let drawer = $state<string | null>(null);
  /** The styling drawer open under a layer's row: colour by, or opacity by. */
  let styling = $state<{ id: string; part: "color" | "opacity" } | null>(null);
  let styleChoice = $state(-1);
  let styleEl = $state<BoardStyle>();
  let styleH = $state(0);
  /** A layer of objects with a table: it can be styled by a column. */
  const hasTable = (id: string): boolean => { const L = byId.get(id); return !!L && (L.kind === "labels" || (L.kind === "vector" && !!L.table)); };
  function openStyle(id: string, part: "color" | "opacity"): void {
    drawer = null;
    styling = styling && styling.id === id && styling.part === part ? null : { id, part };
    styleChoice = -1;
    const L = byId.get(id);
    if (styling && asset && L && L.kind !== "intensity") needTable(asset, L.table);
  }
  $effect(() => { if (styling && !ctx.view.layers.some((l) => l.id === styling!.id)) styling = null; });
  /** A styled layer at rest says so on its row: its first colours, or its colour map, or its fade. */
  function chipOf(id: string): string | null {
    const L = ctx.view.layers.find((l) => l.id === id), layer = byId.get(id);
    if (!L?.styleBy || !layer || layer.kind === "intensity" || !asset) return null;
    void $fluximgLutsReady;
    const legend = cachedObjectStyles(tableOf($fluximgTables, asset, layer.table), layer.key ?? null, L.styleBy, resolveLut).legend;
    const c = legend?.color;
    if (c?.kind === "category") { const e = c.entries.slice(0, 4); return e.length ? `linear-gradient(90deg,${e.map((x, i) => `${x.color} ${(i / e.length) * 100}% ${((i + 1) / e.length) * 100}%`).join(",")})` : null; }
    if (c?.kind === "number") return `linear-gradient(90deg,${c.stops.filter((_, i) => i % 2 === 0).join(",")})`;
    if (legend?.opacity) return `linear-gradient(90deg, color-mix(in srgb, ${L.color ?? layer.color ?? "#fffcf0"} 15%, transparent), ${L.color ?? layer.color ?? "#fffcf0"})`;
    // Its table has not arrived: the default colours stand in.
    return L.styleBy.color ? `linear-gradient(90deg,${DEFAULT_PALETTE.slice(0, 3).join(",")})` : null;
  }

  const needle = $derived(filter.trim().toLowerCase());
  $effect(() => { if (asset) for (const l of layers) { const p = layerSvgPath(byId.get(l.id)); if (p && (open[l.id] || needle)) { needLayerText(asset, p); const L = byId.get(l.id); if (L && L.kind !== "intensity") needTable(asset, L.table); } } });

  const CAP = 300;
  interface ObjectRow { kind: "object"; id: string; layerId: string; key: string; cells: Array<[string, string]> }
  interface LayerRow { kind: "layer"; id: string; layerId: string }
  interface MoreRow { kind: "more"; id: string; layerId: string; count: number }
  /** The names of the columns an open layer's rows show, said once above them. */
  interface HeadRow { kind: "head"; id: string; layerId: string; names: string[] }
  type Row = LayerRow | ObjectRow | MoreRow | HeadRow;

  function objectsOf(id: string): ObjectRow[] {
    const layer = byId.get(id), path = layerSvgPath(layer);
    if (!asset || !layer || !path) return [];
    const text = $fluximgLayerText[`${asset.id}|${path}`];
    if (text === undefined) return [];
    let index;
    try { index = objectIndex(text); } catch { return []; }
    const table = layer.kind !== "intensity" ? tableOf($fluximgTables, asset, layer.table) : null;
    const keyCol = table ? table.columns[table.key] : null;
    const rowOf = new Map<string, number>();
    if (keyCol) keyCol.forEach((v, i) => rowOf.set(String(v), i));
    const names = table ? Object.keys(table.columns).filter((c) => c !== table.key && c !== "label") : [];
    return index.map((o) => {
      const r = rowOf.get(o.key);
      const cells: Array<[string, string]> = r === undefined ? [] : names.map((c) => [c, cellText(table!.columns[c][r])]);
      return { kind: "object" as const, id: `obj:${id}/${o.key}`, layerId: id, key: o.key, cells };
    });
  }
  const rows = $derived.by(() => {
    const out: Row[] = [];
    for (const l of layers) {
      out.push({ kind: "layer", id: `layer:${l.id}`, layerId: l.id });
      if (l.kind === "intensity" || !(open[l.id] || needle)) continue;
      let objs = objectsOf(l.id);
      if (needle) objs = objs.filter((o) => o.key.toLowerCase().includes(needle) || o.cells.some(([, v]) => v.toLowerCase().includes(needle)));
      const names = (objs[0]?.cells ?? []).slice(0, 2).map(([name]) => name);
      if (names.length) out.push({ kind: "head", id: `head:${l.id}`, layerId: l.id, names });
      for (const o of objs.slice(0, CAP)) out.push(o);
      if (objs.length > CAP) out.push({ kind: "more", id: `more:${l.id}`, layerId: l.id, count: objs.length - CAP });
    }
    return out;
  });
  /** The rows the keyboard walks (a column header is not one). */
  const walk = $derived(rows.filter((r) => r.kind !== "head"));
  $effect(() => { if (!walk.some((r) => r.id === cursor)) cursor = walk[0]?.id ?? ""; });
  const natural = $derived(13 + (hasObjects ? 31 : 0) + rows.reduce((h, r) => h + (r.kind === "layer" ? 26 + (drawer === r.layerId ? 27 : 0) + (styling?.id === r.layerId ? styleH : 0) : r.kind === "head" ? 16 : 22), 0));
  $effect(() => { onnatural?.(natural); });
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
  function pickColor(id: string, color: string | null): void {
    setLayer(id, { color: color as never }, `layer-color:${id}`);
    settleLiveEdit();
    drawer = null;
  }

  // A layer's opacity is a small dial on its row: roll the wheel over it, or drag it sideways (100 px = all of it).
  let scrub = $state.raw<{ pointer: number; id: string; x: number; from: number } | null>(null);
  function scrubDown(e: PointerEvent, id: string, from: number): void {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrub = { pointer: e.pointerId, id, x: e.clientX, from };
  }
  function scrubMove(e: PointerEvent): void {
    if (!scrub || e.pointerId !== scrub.pointer) return;
    const o = Math.min(1, Math.max(0, Math.round((scrub.from + (e.clientX - scrub.x) / 100) * 100) / 100));
    setLayer(scrub.id, { opacity: o }, `layer-opacity-drag:${scrub.id}`);
  }
  function scrubUp(e: PointerEvent): void {
    if (!scrub || e.pointerId !== scrub.pointer) return;
    scrub = null;
    if (e.type === "pointerup") settleLiveEdit(); else cancelLiveEdit();
  }

  function hover(r: Row | null): void {
    if (r && r.kind === "object") fluximgHover.set({ layerId: r.layerId, key: r.key, from: "list" });
    else if ($fluximgHover?.from === "list") fluximgHover.set(null);
  }
  // An object hovered ON THE IMAGE finds its row, when its layer is open (the card never opens under the pointer's feet).
  $effect(() => {
    const h = $fluximgHover;
    if (!h || h.from !== "image" || !open[h.layerId]) return;
    void tick().then(() => listEl?.querySelector(`[data-rid="${CSS.escape(`obj:${h.layerId}/${h.key}`)}"]`)?.scrollIntoView({ block: "nearest" }));
  });
  function move(by: number): void {
    const i = Math.max(0, walk.findIndex((r) => r.id === cursor)), next = walk[Math.min(walk.length - 1, Math.max(0, i + by))];
    if (!next) return;
    cursor = next.id;
    hover(next);
    void tick().then(() => listEl?.querySelector(`[data-rid="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  // Capture phase: with the keys in hand the card sees them BEFORE the board's window handler.
  $effect(() => {
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });
  function onKey(e: KeyboardEvent): void {
    if (yieldsToShellModal(e) || isAnnotateChord(e) || e.ctrlKey || e.metaKey || e.defaultPrevented || get(fluxFigMenuOpen)) return;
    const typing = e.target === filterEl;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = (): void => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (typing) {
      // The filter keeps its letters; the arrows still walk the list, and Enter or Esc hands the keyboard back.
      if (k === "ArrowDown") { done(); move(1); } else if (k === "ArrowUp") { done(); move(-1); }
      else if (k === "Enter") { done(); filterEl?.blur(); }
      else if (k === "Escape" && filter) { done(); filter = ""; }
      else if (k === "Escape") { done(); filterEl?.blur(); }
      else e.stopImmediatePropagation();
      return;
    }
    // An open styling drawer answers its own keys wherever the keyboard is: digits pick (0 = none), arrows walk
    // (each key previewed on the image), Enter picks, Esc closes.
    if (styling && styleEl) {
      const digit = /^Digit([0-9])$/.exec(e.code);
      const n = styleEl.count();
      if (digit && !e.shiftKey && !e.altKey) { done(); if (Number(digit[1]) < n) styleEl.pickAt(Number(digit[1])); return; }
      if (k === "ArrowRight" || k === "ArrowLeft") { done(); styleChoice = ((styleChoice < 0 ? (k === "ArrowRight" ? -1 : 0) : styleChoice) + (k === "ArrowRight" ? 1 : n - 1)) % n; styleEl.previewAt(styleChoice); return; }
      if ((k === "Enter" || k === " ") && styleChoice >= 0) { done(); styleEl.pickAt(styleChoice); return; }
      if (k === "Escape") { done(); styling = null; return; }
    }
    if (!keys) return;
    if (k === "Escape") { if (drawer) { done(); drawer = null; } return; } // otherwise the board takes the keys back
    const id = current?.layerId;
    switch (k) {
      case "ArrowDown": case "s": done(); if (e.shiftKey && id) moveLayer(id, -1); else move(1); return;
      case "ArrowUp": case "w": done(); if (e.shiftKey && id) moveLayer(id, 1); else move(-1); return;
      case "ArrowRight": case "ArrowLeft": case "Enter": case " ":
        done();
        if (current?.kind === "layer" && currentLayer?.kind !== "intensity") open = { ...open, [current.layerId]: k === "ArrowRight" ? true : k === "ArrowLeft" ? false : !open[current.layerId] };
        return;
      case "x": done(); if (id) toggleLayer(id); return;
      case "e": done(); if (id) armLive(armed === `layer:${id}` ? null : `layer:${id}`); return;
      case "q": done(); if (id && currentLayer?.kind !== "intensity") toggleNames(id); return;
      case "c": done(); if (id) drawer = drawer === id ? null : id; return;
      case "b": done(); if (id && hasTable(id)) openStyle(id, "color"); return;
      case "t": done(); if (id && hasTable(id)) openStyle(id, "opacity"); return;
      case "a": done(); void tick().then(() => filterEl?.focus()); return;
      case "d": done(); onkeys(false); return;
    }
    if (k.length === 1 && k !== "r" && k !== "f") done(); // with the keys in hand, stray letters do nothing
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="layers" class:keys style={`width:${width}px;max-height:${maxHeight}px`} data-fxb-layers>
  {#if hasObjects}
    <div class="findrow">
      <label class="find" class:active={!!filter}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2l3.6 3.6" /></svg>
        <input bind:this={filterEl} bind:value={filter} placeholder="filter objects" spellcheck="false" aria-label="Filter objects by name or value" onpointerdown={(e) => e.stopPropagation()} />
      </label>
      <!-- The key to the objects' colours: an annotation like the scale bar (Shift: its next corner; drag it on the image). -->
      {#if stylable}<span class="keykey"><PaperKey size={22} glyph="key" id="key" label={styledAny || ctx.view.furniture.key ? "Key to the objects' colours · ⇧: next corner" : "Key to the objects' colours (colour a layer by a column first)"}
        disabled={!styledAny && !ctx.view.furniture.key} on={!!ctx.view.furniture.key}
        onpress={(e) => { if (e.shiftKey && ctx.view.furniture.key) cycleFurnitureCorner("key"); else toggleFurniture("key"); }} /></span>{/if}
    </div>
  {/if}
  <div class="list scrolls" bind:this={listEl} role="tree" tabindex="-1" aria-label="Layers and objects" onpointerleave={() => hover(null)}>
    {#each rows as r (r.id)}
      {#if r.kind === "layer"}
        {@const L = ctx.view.layers.find((l) => l.id === r.layerId)!}
        {@const layer = byId.get(r.layerId)}
        {@const ink = L.color ?? layer?.color ?? "#cecdc3"}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div class="row lay" class:sel={keys && r.id === cursor} class:off={!L.visible} class:hand={armed === `layer:${L.id}`} role="treeitem" tabindex="-1" aria-selected={r.id === cursor} data-rid={r.id}
          style={`--ink:${ink}`} onclick={() => { cursor = r.id; if (L.kind !== "intensity") open = { ...open, [L.id]: !open[L.id] }; }} onpointerenter={() => hover(null)}>
          <button class="lamp" type="button" aria-label={L.visible ? `Hide ${L.name}` : `Show ${L.name}`} aria-pressed={L.visible} data-tip={L.visible ? "Hide" : "Show"} onclick={(e) => { e.stopPropagation(); toggleLayer(L.id); }}></button>
          <span class="name">{L.name}</span>
          {#if L.styleBy}{@const chip = chipOf(L.id)}{#if chip}<!-- svelte-ignore a11y_click_events_have_key_events --><span class="chip" role="button" tabindex="-1" style={`background:${chip}`} data-fxb-style-chip={L.id}
            data-tip={[L.styleBy.color ? `Colour by ${L.styleBy.color.column}` : "", L.styleBy.opacity ? `opacity by ${L.styleBy.opacity.column}` : ""].filter(Boolean).join(" · ")}
            onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); openStyle(L.id, L.styleBy?.color ? "color" : "opacity"); }}></span>{/if}{/if}
          <span class="rkeys">
            {#if L.kind !== "intensity"}<PaperKey quiet size={18} glyph="names" label="Names on the image" on={namesOn(L.id)} onpress={() => toggleNames(L.id)} />{/if}
            <PaperKey quiet size={18} glyph="color" label="Colour" on={drawer === L.id} onpress={() => { styling = null; drawer = drawer === L.id ? null : L.id; }} />
            {#if hasTable(L.id)}
              <PaperKey quiet size={18} glyph="colorBy" label="Colour by a column" hotkey={keys ? "B" : ""} id={`style-color:${L.id}`} on={styling?.id === L.id && styling.part === "color" || !!L.styleBy?.color} onpress={() => openStyle(L.id, "color")} />
              <PaperKey quiet size={18} glyph="opacityBy" label="Opacity by a column" hotkey={keys ? "T" : ""} id={`style-opacity:${L.id}`} on={styling?.id === L.id && styling.part === "opacity" || !!L.styleBy?.opacity} onpress={() => openStyle(L.id, "opacity")} />
            {/if}
          </span>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="pct" class:full={L.opacity >= 1} class:held={scrub?.id === L.id} data-fxb-wheel={`layer:${L.id}`} data-tip="Opacity · roll, or drag sideways"
            onpointerdown={(e) => scrubDown(e, L.id, L.opacity)} onpointermove={scrubMove} onpointerup={scrubUp} onpointercancel={scrubUp} onclick={(e) => e.stopPropagation()}>{Math.round(L.opacity * 100)}%</span>
          {#if layer && layer.kind !== "intensity"}<span class="count">{layer.count.toLocaleString("en-US")}</span><svg class="tw" class:open={open[L.id] || !!needle} viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.6l4.4 4.4L6 12.4" /></svg>{/if}
          <span class="meter" style={`width:${Math.round(L.opacity * 100)}%`}></span>
        </div>
        {#if styling?.id === L.id && layer && layer.kind !== "intensity"}
          <div class="styledrawer" bind:offsetHeight={styleH}>
            <BoardStyle bind:this={styleEl} bind:choice={styleChoice} {layer} lv={L} table={tableOf($fluximgTables, asset ?? { id: "" }, layer.table)} part={styling.part} width={width - 2} onpicked={() => { styleChoice = -1; }} />
          </div>
        {/if}
        {#if drawer === L.id}
          <div class="drawer" role="listbox" aria-label={`Colour of ${L.name}`}>
            {#each COLORS as o (o.label)}
              <button class="sw" class:cur={(L.color ?? null) === o.color} class:own={!o.color} type="button" role="option" aria-selected={(L.color ?? null) === o.color} aria-label={o.label} data-tip={o.label}
                style={o.color ? `background:${o.color}` : `background:${layer?.color ?? "#cecdc3"}`} onclick={(e) => { e.stopPropagation(); pickColor(L.id, o.color); }}></button>
            {/each}
          </div>
        {/if}
      {:else if r.kind === "object"}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
        <div class="row obj" class:sel={keys && r.id === cursor} class:hot={$fluximgHover?.layerId === r.layerId && $fluximgHover?.key === r.key} role="treeitem" tabindex="-1" aria-selected={r.id === cursor} data-rid={r.id}
          onclick={() => { cursor = r.id; }} onpointerenter={() => hover(r)}>
          <span class="key">{r.key}</span>
          {#each r.cells.slice(0, 2) as [name, value] (name)}<span class="cell" data-col={name}>{value}</span>{/each}
        </div>
      {:else if r.kind === "head"}
        <div class="row colhead" aria-hidden="true"><span class="key"></span>{#each r.names as name (name)}<span class="cell">{name}</span>{/each}</div>
      {:else}
        <div class="row more" data-rid={r.id}>{r.count.toLocaleString("en-US")} more: filter to narrow</div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .layers { display: flex; flex-direction: column; box-sizing: border-box; padding: 5px 0 6px; border-radius: 11px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift), var(--fxb-shadow); color: var(--fxb-tx); user-select: none; transition: border-color 90ms linear; }
  .layers.keys { border-color: color-mix(in oklab, var(--fxb-pink) 62%, transparent); }
  .findrow { display: flex; align-items: center; gap: 4px; margin: 2px 7px 5px; flex: none; }
  .findrow .find { flex: 1; margin: 0; }
  .keykey { flex: none; }
  .find { display: flex; align-items: center; gap: 6px; height: 24px; margin: 2px 7px 5px; padding: 0 7px; border-radius: 12px; background: var(--fxb-well); box-shadow: inset 0 0 0 1px rgba(255, 252, 240, 0.08); color: var(--fxb-tx-dim); flex: none; }
  .find.active { box-shadow: inset 0 0 0 1px var(--fxb-pink); }
  .find svg { width: 11px; height: 11px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .find input { flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: none; color: var(--fxb-tx-hi); font: 11.5px var(--font-ui); }
  .find input::placeholder { color: var(--fxb-tx-dim); }
  .list { overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(255, 252, 240, 0.18) transparent; }
  .row { position: relative; display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 9px 0 10px; white-space: nowrap; cursor: var(--cursor-cross-hover); }
  .row:not(.more):hover { background: rgba(255, 252, 240, 0.06); }
  .row.sel { background: color-mix(in oklab, var(--fxb-pink) 16%, transparent); }
  .row.hand { box-shadow: inset 2px 0 0 var(--fxb-pink); }
  /* A layer's lamp: its own colour, lit when it is shown. */
  .lamp { flex: none; width: 12px; height: 12px; padding: 0; border: 0; border-radius: 50%; background: var(--ink); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 6px -1px var(--ink); cursor: var(--cursor-cross-hover); }
  .row.off .lamp { background: transparent; box-shadow: inset 0 0 0 1.5px var(--ink); }
  .lamp:hover { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px color-mix(in oklab, var(--ink) 55%, transparent); }
  .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 600 12px var(--font-ui); color: var(--fxb-tx-hi); }
  .row.off .name { color: var(--fxb-tx-dim); font-weight: 500; }
  .rkeys { gap: 1px; margin-left: auto; }
  .rkeys { display: none; }
  .row:hover .rkeys, .row.sel .rkeys { display: inline-flex; opacity: 1; }
  .row.lay .name { margin-right: auto; }
  .pct, .count { flex: none; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-dim); }
  /* The opacity dial: there when the layer is not opaque, or when the row is wanted. */
  .pct { padding: 1px 4px; border-radius: 3px; cursor: ew-resize; touch-action: none; }
  .pct.full { display: none; }
  .row:hover .pct.full, .row.sel .pct.full, .pct.held { display: inline; }
  .pct:hover, .pct.held { background: rgba(255, 252, 240, 0.1); color: var(--fxb-tx-hi); }
  .row.hand .pct { color: var(--fxb-pink-hi); }
  .row.lay:hover .count, .row.lay.sel .count { display: none; }
  .tw { flex: none; width: 9px; height: 9px; fill: none; stroke: var(--fxb-tx-dim); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 90ms linear; }
  .tw.open { transform: rotate(90deg); }
  /* Opacity, as a hairline under the row. */
  .meter { position: absolute; left: 10px; bottom: 1px; max-width: calc(100% - 19px); height: 1.5px; border-radius: 1px; background: var(--ink); opacity: 0.55; pointer-events: none; }
  .row.off .meter { opacity: 0.2; }
  .row.obj { height: 22px; padding-left: 29px; gap: 10px; }
  .row.hot { background: color-mix(in oklab, var(--fxb-pink) 26%, transparent); }
  /* An object's row: its name, then the first two columns of its table (named once, above). */
  .key { flex: 0 0 58px; overflow: hidden; text-overflow: ellipsis; font: 11px var(--font-mono); color: var(--fxb-tx-hi); }
  .cell { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; font: 10.5px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx); }
  .row.colhead { height: 16px; padding-left: 29px; gap: 10px; cursor: var(--cursor-cross); }
  .row.colhead:hover { background: none; }
  .row.colhead .cell { color: var(--fxb-tx-dim); font-size: 9.5px; }
  .row.more { padding-left: 29px; height: 22px; cursor: var(--cursor-cross); color: var(--fxb-tx-dim); font: 10.5px var(--font-ui); }
  .drawer { display: flex; align-items: center; gap: 5px; padding: 5px 9px 7px 29px; }
  /* A styled layer's chip: what its colours (or fade) are, at rest, beside its name. Click: change it. */
  .row.lay .name:has(+ .chip) { margin-right: 0; }
  .chip { margin-right: auto; flex: none; width: 22px; height: 8px; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); cursor: var(--cursor-cross-hover); }
  .chip:hover { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 2.5px color-mix(in oklab, var(--fxb-pink) 70%, transparent); }
  .styledrawer { border-top: 1px solid var(--fxb-line); border-bottom: 1px solid var(--fxb-line); background: color-mix(in oklab, var(--fxb-plate) 40%, var(--fxb-card)); }
  .sw { flex: none; width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 1px solid rgba(255, 252, 240, 0.28); cursor: var(--cursor-cross-hover); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }
  .sw.own { border-style: dashed; }
  .sw.cur { box-shadow: 0 0 0 2px var(--fxb-card), 0 0 0 3.5px var(--fxb-pink); }
</style>
