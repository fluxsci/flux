<script lang="ts">
  // The colormap picker (2026-09-16, owner request): every map fluxplot ships,
  // one collection at a time — tabs across the top (click, or Shift+Tab cycles),
  // the maps of the collection grouped by type (sequential · diverging · cyclic ·
  // qualitative · misc), each as a preview bar. Two ways to use it:
  //   · "map" mode returns the qualified name (`crameri.batlow`, `tol.sunset_r`)
  //     — what a plot's colour scale regenerates with;
  //   · "color" mode returns a hex: hovering along the chosen map's bar previews
  //     the colour at that position, a click commits it (fill / stroke / part);
  //     with `gradient` on, x / y (keys or the footer buttons) apply the WHOLE
  //     map as a gradient along that axis of the element (owner note).
  // Keyboard: ↑/↓ or w/s walk the maps, ←/→ or a/d move along the bar in colour
  // mode, r reverses, Enter applies, Escape cancels. Pure data through
  // color/collections.ts; the component owns no colour maths of its own.
  import { onMount } from "svelte";
  import { settings } from "./settings";
  import {
    COLORMAP_COLLECTIONS,
    colormapsByType,
    colormapGradient,
    colormapColorAt,
    findColormap,
    qualifiedName,
    nextId,
    type ColormapCollection,
    type ColormapDef,
  } from "./color/collections";

  /** "map": pick a map (returns its qualified name); "color": pick a colour along a map (returns hex). */
  export let mode: "map" | "color" = "map";
  /** The current qualified map name (or bare / _r), to land the cursor on it. */
  export let value = "";
  /** Colour mode: live preview of the hovered colour. */
  export let onPreview: (hex: string) => void = () => {};
  /** A pick: the qualified map name in map mode, a hex in colour mode. */
  export let onPick: (v: string) => void = () => {};
  export let onCancel: () => void = () => {};
  export let autofocus = true;
  /** Colour mode: offer "apply as a gradient along x / y" (elements, not parts). */
  export let gradient = false;
  /** A gradient pick: the qualified map name and the axis it runs along. */
  export let onPickGradient: (map: string, axis: "x" | "y") => void = () => {};

  const start = findColormap(value);
  let collectionId = start?.collection.id ?? $settings.colormapCollection;
  if (!COLORMAP_COLLECTIONS.some((c) => c.id === collectionId)) collectionId = COLORMAP_COLLECTIONS[0].id;
  let reversed = start?.reversed ?? false;
  let selected: ColormapDef | null = start?.map ?? null;
  /** colour mode: position along the selected map (0–1) */
  let t = 0.5;
  let rootEl: HTMLDivElement;
  let barEl: HTMLDivElement;

  $: collection = (COLORMAP_COLLECTIONS.find((c) => c.id === collectionId) ?? COLORMAP_COLLECTIONS[0]) as ColormapCollection;
  $: groups = colormapsByType(collection);
  $: flat = groups.flatMap((g) => g.maps);
  $: if (selected && !collection.maps.includes(selected)) selected = flat[0] ?? null;
  $: current = selected ? qualifiedName(collection, selected, reversed) : "";
  $: currentHex = selected ? colormapColorAt(selected, t, reversed) : "";

  onMount(() => {
    if (!selected) selected = flat[0] ?? null;
    if (autofocus) requestAnimationFrame(() => rootEl?.focus({ preventScroll: true }));
    requestAnimationFrame(() => rootEl?.querySelector<HTMLElement>(".cm.cur")?.scrollIntoView({ block: "nearest" }));
  });

  function setCollection(id: string) {
    collectionId = id;
    selected = null; // the reactive block lands on the first map
    requestAnimationFrame(() => rootEl?.querySelector<HTMLElement>(".cm.cur")?.scrollIntoView({ block: "nearest" }));
  }
  /** Next collection (Shift+Tab); exported so a host can drive it. */
  export function cycle(step = 1) {
    setCollection(nextId(COLORMAP_COLLECTIONS.map((c) => c.id), collectionId, step));
  }
  // Shift+Tab cycles the collections from anywhere while the picker is up —
  // never dependent on which element holds focus (window, capture phase).
  function onWinKey(e: KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cycle(1);
    }
  }
  function choose(m: ColormapDef) {
    selected = m;
    if (mode === "color") onPreview(colormapColorAt(m, t, reversed));
  }
  function walk(d: number) {
    if (!flat.length) return;
    const i = selected ? flat.indexOf(selected) : -1;
    choose(flat[Math.max(0, Math.min(flat.length - 1, i + d))]);
    requestAnimationFrame(() => rootEl?.querySelector<HTMLElement>(".cm.cur")?.scrollIntoView({ block: "nearest" }));
  }
  function apply() {
    if (!selected) return;
    // Compute from the live state, not the `$:` derivations — a click sets
    // `selected` and applies in the same handler, before Svelte re-derives.
    onPick(mode === "color" ? colormapColorAt(selected, t, reversed) : qualifiedName(collection, selected, reversed));
  }
  function applyGradient(axis: "x" | "y") {
    if (!selected || !gradient) return;
    onPickGradient(qualifiedName(collection, selected, reversed), axis);
  }
  function barPos(e: PointerEvent): number {
    const r = barEl.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
  }
  function onBarMove(e: PointerEvent) {
    t = barPos(e);
    if (selected) onPreview(colormapColorAt(selected, t, reversed));
  }
  function onBarClick(e: PointerEvent) {
    t = barPos(e);
    apply();
  }
  function onKey(e: KeyboardEvent) {
    const k = e.key;
    const lk = k.toLowerCase();
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (k === "Enter" || k === " ") { e.preventDefault(); e.stopPropagation(); apply(); return; }
    if (k === "Tab" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); cycle(1); return; }
    if (k === "ArrowDown" || lk === "s") { e.preventDefault(); e.stopPropagation(); walk(1); return; }
    if (k === "ArrowUp" || lk === "w") { e.preventDefault(); e.stopPropagation(); walk(-1); return; }
    if (lk === "r") { e.preventDefault(); e.stopPropagation(); reversed = !reversed; if (mode === "color" && selected) onPreview(colormapColorAt(selected, t, reversed)); return; }
    if (mode === "color" && gradient && (lk === "x" || lk === "y")) { e.preventDefault(); e.stopPropagation(); applyGradient(lk); return; }
    if (mode === "color" && (k === "ArrowRight" || lk === "d" || k === "ArrowLeft" || lk === "a")) {
      e.preventDefault(); e.stopPropagation();
      t = Math.min(1, Math.max(0, t + (k === "ArrowRight" || lk === "d" ? 0.05 : -0.05)));
      if (selected) onPreview(colormapColorAt(selected, t, reversed));
      return;
    }
    e.stopPropagation(); // every other key stays inside the picker
  }
</script>

<svelte:window on:keydown|capture={onWinKey} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
<div class="cmp" bind:this={rootEl} tabindex="0" role="listbox" aria-label="Colormaps" on:keydown={onKey}>
  <div class="tabs" role="tablist" aria-label="Colormap collections">
    {#each COLORMAP_COLLECTIONS as c (c.id)}
      <button class="tab" type="button" class:on={c.id === collectionId} role="tab" aria-selected={c.id === collectionId} title={c.description} on:click={() => setCollection(c.id)}>{c.name}</button>
    {/each}
    <span class="tabhint"><b>⇧⇥</b> next collection</span>
  </div>
  <div class="list">
    {#each groups as g (g.type)}
      <div class="gtitle">{g.type}<span class="gcount">{g.maps.length}</span></div>
      {#each g.maps as m (m.name)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="cm" class:cur={m === selected} role="option" tabindex="-1" aria-selected={m === selected} data-map={m.name} title={qualifiedName(collection, m)}
          on:pointerenter={() => { if (mode === "map") selected = m; }} on:click={() => { choose(m); if (mode === "map") apply(); }}>
          <span class="bar" style={`background:${colormapGradient(m, reversed)}`}></span>
          <span class="nm">{m.name}{#if m.family}<span class="fam">{m.family}</span>{/if}</span>
        </div>
      {/each}
    {/each}
  </div>
  <div class="foot">
    {#if selected}
      {#if mode === "color"}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="pick" bind:this={barEl} style={`background:${colormapGradient(selected, reversed)}`} on:pointermove={onBarMove} on:pointerdown={onBarClick}>
          <span class="mark" style={`left:${t * 100}%; background:${currentHex}`}></span>
        </div>
        <span class="cur-name"><b>{current}</b> · {currentHex}</span>
        {#if gradient}
          <span class="grad" role="group" aria-label="Apply as a gradient">
            <span class="glabel">whole map as a gradient</span>
            <button type="button" class="gbtn" data-axis="x" title="Lay the map across the element left→right (x)" on:click={() => applyGradient("x")}>along <b>x</b></button>
            <button type="button" class="gbtn" data-axis="y" title="Lay the map across the element bottom→top (y)" on:click={() => applyGradient("y")}>along <b>y</b></button>
          </span>
        {/if}
      {:else}
        <span class="cur-name"><b>{current}</b>{#if selected.discrete} · {selected.colors.length} colours{/if}</span>
      {/if}
    {/if}
    <span class="hint"><b>↑↓</b> walk · <b>r</b> reverse{mode === "color" ? " · hover the bar, click applies" : " · click applies"}{mode === "color" && gradient ? " · x/y gradient" : ""} · <b>esc</b> cancel</span>
  </div>
</div>

<style>
  .cmp { display: flex; flex-direction: column; gap: 6px; outline: none; min-width: 0; font-family: inherit; }
  .cmp:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 0; border-radius: var(--r-0); }
  .tabs { display: flex; align-items: center; gap: 2px; border-bottom: 1px solid var(--c-line); padding-bottom: 4px; }
  .tab { height: 22px; padding: 0 9px; background: transparent; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx-2); font: 12px var(--font-serif); white-space: nowrap; }
  .tab:hover { color: var(--c-tx-hi); border-color: var(--c-line-strong); }
  .tab.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .tabhint { margin-left: auto; font: 10.5px var(--font-mono); color: var(--c-tx-muted); }
  .tabhint b { color: var(--c-tx-2); }
  .grad { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .glabel { font: 11px var(--font-serif); color: var(--c-tx-muted); margin-right: 2px; }
  .gbtn { height: 20px; padding: 0 8px; background: var(--c-bg-2); border: 1px solid var(--c-line); border-radius: var(--r-ui); color: var(--c-tx-2); font: 11px var(--font-serif); white-space: nowrap; }
  .gbtn b { font: 600 10.5px var(--font-mono); color: var(--c-tx-hi); }
  .gbtn:hover { border-color: var(--c-accent); color: var(--c-tx-hi); background: var(--c-accent-tint); }
  .list { display: flex; flex-direction: column; gap: 1px; max-height: min(56vh, 620px); overflow-y: auto; padding-right: 2px; }
  .gtitle { display: flex; align-items: center; gap: 8px; font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); padding: 8px 4px 3px; border-bottom: 1px solid var(--c-line); margin-bottom: 2px; }
  .gtitle:first-child { padding-top: 2px; }
  .gcount { color: var(--c-tx-faint); font-weight: 400; }
  .cm { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(0, 150px); align-items: center; gap: 8px; height: 22px; padding: 0 4px; border-radius: var(--r-ui); }
  .cm:hover { background: var(--c-bg-raised); }
  .cm.cur { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); }
  .bar { display: block; height: 12px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 14%, transparent); }
  .nm { display: flex; align-items: baseline; gap: 6px; min-width: 0; font: 12px var(--font-mono); color: var(--c-tx); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fam { font-size: 9.5px; color: var(--c-tx-faint); }
  .foot { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--c-line); padding-top: 6px; }
  .pick { position: relative; height: 18px; border-radius: var(--r-ui); border: 1px solid var(--c-line-strong); touch-action: none; }
  .mark { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .cur-name { font: 11px var(--font-mono); color: var(--c-tx-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cur-name b { color: var(--c-tx-hi); font-weight: 600; }
  .hint { font-size: 10.5px; color: var(--c-tx-muted); }
  .hint b { color: var(--c-tx-2); font-weight: 600; }
</style>
