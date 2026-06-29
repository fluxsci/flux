<script lang="ts">
  import { onMount } from "svelte";
  import { project } from "./store";
  import { popIn } from "./motion/actions";
  import {
    applyColor,
    addRecentColor,
    setOpacity,
    setStrokeWidth,
    currentColor,
  } from "./colors";

  export let target: "fill" | "stroke" = "fill";
  export let onDone: () => void = () => {};
  export let onCancel: () => void = () => {};

  let inputEl: HTMLInputElement;
  let listEl: HTMLDivElement;
  let query = "";
  let index = 0;
  let expanded = false;
  let hexVal = currentColor(target);

  $: items = (() => {
    const out: { label: string; name: string; hex: string }[] = [];
    for (const c of $project.palette) out.push({ label: "recent", name: c, hex: c });
    for (const g of $project.colorGroups ?? [])
      for (const s of g.swatches) out.push({ label: g.name, name: s.name, hex: s.hex });
    return out;
  })();
  $: q = query.trim().toLowerCase();
  $: filtered = q
    ? items
        .filter((it) => `${it.label} ${it.name} ${it.hex}`.toLowerCase().includes(q))
        .sort((a, b) => rank(a, q) - rank(b, q))
    : items;
  $: if (index >= filtered.length) index = Math.max(0, filtered.length - 1);

  function rank(it: { label: string; name: string }, q: string) {
    const n = it.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (it.label.toLowerCase().startsWith(q)) return 2;
    return 3;
  }

  onMount(() => requestAnimationFrame(() => inputEl?.focus()));

  function ensureVisible() {
    requestAnimationFrame(() =>
      listEl?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  }
  function pick(hex: string) {
    applyColor(hex, target);
    addRecentColor(hex);
    onDone();
  }
  function liveHex(hex: string) {
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
      hexVal = hex;
      applyColor(hex, target);
    }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      index = Math.min(filtered.length - 1, index + 1);
      ensureVisible();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, index - 1);
      ensureVisible();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[index];
      if (it) pick(it.hex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab") {
      e.preventDefault();
      expanded = !expanded;
    }
  }
</script>

<div class="cs" in:popIn>
  <div class="bar">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="search"
      placeholder="color name or hex…  (Tab = full picker)"
      spellcheck="false"
      on:keydown={onKey}
    />
    <button class="exp" class:on={expanded} title="Full picker (Tab)" on:click={() => (expanded = !expanded)}>⤢</button>
  </div>

  {#if expanded}
    <div class="editor">
      <div class="erow">
        <input type="color" value={hexVal} on:input={(e) => liveHex(e.currentTarget.value)} />
        <input class="hex" value={hexVal} spellcheck="false" on:input={(e) => liveHex(e.currentTarget.value)} on:keydown={(e) => { if (e.key === "Enter") pick(hexVal); }} />
      </div>
      <label class="erow"><span>Opacity</span><input type="range" min="0" max="1" step="0.01" value="1" on:input={(e) => setOpacity(parseFloat(e.currentTarget.value))} /></label>
      <label class="erow"><span>Stroke W</span><input type="number" min="0" step="0.5" value="2" on:change={(e) => setStrokeWidth(parseFloat(e.currentTarget.value))} /></label>
    </div>
  {/if}

  <div class="list" bind:this={listEl}>
    {#each filtered as it, i (it.label + it.name + i)}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="item" class:active={i === index} data-i={i} on:pointerenter={() => (index = i)} on:click={() => pick(it.hex)}>
        <span class="chip" style={`background:${it.hex}`}></span>
        <span class="name">{it.name}</span>
        <span class="grp">{it.label}</span>
        <span class="hexlabel">{it.hex}</span>
      </div>
    {/each}
    {#if filtered.length === 0}<div class="empty">No matches</div>{/if}
  </div>
</div>

<style>
  .cs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bar {
    display: flex;
    gap: 6px;
  }
  .search {
    flex: 1;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 7px 9px;
    font-size: 13px;
    outline: none;
    font-family: inherit;
  }
  .search:focus {
    border-color: var(--c-accent);
  }
  .exp {
    width: 32px;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    cursor: pointer;
  }
  .exp.on,
  .exp:hover {
    background: var(--c-ui-hover);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px;
    background: color-mix(in oklab, var(--c-bg) 45%, transparent);
    border-radius: 6px;
  }
  .erow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .erow span {
    width: 64px;
    opacity: 0.7;
    font-size: 12px;
  }
  .erow input[type="color"] {
    width: 34px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    background: none;
  }
  .hex,
  .erow input[type="number"],
  .erow input[type="range"] {
    flex: 1;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    color: var(--c-tx);
    padding: 5px 7px;
    font-family: var(--font-mono);
  }
  .list {
    max-height: 240px;
    overflow-y: auto;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .item.active {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .chip {
    width: 15px;
    height: 15px;
    border-radius: 4px;
    border: 1px solid #00000055;
    flex: none;
  }
  .name {
    flex: 1;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grp {
    opacity: 0.5;
    font-size: 11px;
    text-transform: capitalize;
  }
  .item.active .grp {
    opacity: 0.85;
  }
  .hexlabel {
    font-family: monospace;
    font-size: 11px;
    opacity: 0.55;
  }
  .item.active .hexlabel {
    opacity: 0.9;
  }
  .empty {
    padding: 12px;
    text-align: center;
    opacity: 0.45;
  }
</style>
