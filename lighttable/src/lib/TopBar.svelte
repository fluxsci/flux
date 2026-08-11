<script lang="ts">
  import { store } from "./store.svelte";
  import SetSwitcher from "./SetSwitcher.svelte";
  import AnnotSwitcher from "./AnnotSwitcher.svelte";
  import type { RecentEntry } from "./types";

  let menuOpen = $state(false);
  let menuEl = $state<HTMLDivElement | null>(null);
  let sistersOpen = $state(false);
  let sisters = $state<RecentEntry[]>([]);
  let collEl = $state<HTMLDivElement | null>(null);

  function onWindowPointerDown(e: PointerEvent) {
    if (menuOpen && menuEl && !menuEl.contains(e.target as Node)) menuOpen = false;
    if (sistersOpen && collEl && !collEl.contains(e.target as Node)) sistersOpen = false;
  }
  async function toggleMenu() {
    if (!menuOpen) await store.refreshRecents();
    menuOpen = !menuOpen;
  }
  // Plain click: sister folders (collections beside this one). Ctrl+click:
  // the native picker for opening anything else.
  async function onCollClick(e: MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      sistersOpen = false;
      void store.openViaDialog();
      return;
    }
    if (!sistersOpen) sisters = (await store.api?.siblings()) ?? [];
    sistersOpen = !sistersOpen;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<header class="topbar">
  <div class="coll-anchor" bind:this={collEl}>
    <button
      class="coll-name"
      title="Sister folders — Ctrl+click to open another collection"
      onclick={(e) => void onCollClick(e)}
    >
      {store.manifest?.name ?? "Lighttable"}
    </button>
    {#if sistersOpen}
      <div class="menu sisters" data-sisters>
        {#if sisters.length === 0}
          <div class="about">No sister folders</div>
        {/if}
        {#each sisters as s (s.path)}
          <button
            class:active={s.path === store.manifest?.root}
            title={s.path}
            onclick={() => {
              sistersOpen = false;
              if (s.path !== store.manifest?.root) void store.openPath(s.path);
            }}>{s.name}</button
          >
        {/each}
      </div>
    {/if}
  </div>

  <SetSwitcher />

  <AnnotSwitcher />

  <div class="col-ctl" title="Columns  ( [ and ] )">
    <button aria-label="Fewer columns" onclick={() => store.setCols(store.cols - 1)}>−</button>
    <span class="readout" data-cols-readout>{store.cols} cols</span>
    <button aria-label="More columns" onclick={() => store.setCols(store.cols + 1)}>+</button>
  </div>

  <input
    class="search"
    type="search"
    placeholder="Filter…   /"
    aria-label="Filter items by filename"
    bind:value={store.search}
    bind:this={store.searchEl}
  />

  <div class="grow"></div>

  <div class="menu-anchor" bind:this={menuEl}>
    <button class="overflow" aria-label="Menu" aria-expanded={menuOpen} onclick={() => void toggleMenu()}>⋯</button>
    {#if menuOpen}
      <div class="menu">
        <button
          onclick={() => {
            menuOpen = false;
            void store.openViaDialog();
          }}>Open collection…</button
        >
        <button onclick={() => store.toggleCaptions()}>
          {store.captions ? "Hide captions" : "Show captions"}
        </button>
        <button
          disabled={!store.selectedKey}
          onclick={() => {
            menuOpen = false;
            store.revealSelected();
          }}>Reveal selected in file manager</button
        >
        <div class="sep"></div>
        <div class="label">Grid gaps</div>
        <div class="gap-row">
          <span class="gap-name">Horizontal</span>
          <button class="step" aria-label="Smaller horizontal gap" onclick={() => store.setHGap(store.hGap - 2)}>−</button>
          <span class="gap-val" data-hgap>{store.hGap}</span>
          <button class="step" aria-label="Larger horizontal gap" onclick={() => store.setHGap(store.hGap + 2)}>+</button>
        </div>
        <div class="gap-row">
          <span class="gap-name">Vertical</span>
          <button class="step" aria-label="Smaller vertical gap" onclick={() => store.setVGap(store.vGap - 2)}>−</button>
          <span class="gap-val" data-vgap>{store.vGap}</span>
          <button class="step" aria-label="Larger vertical gap" onclick={() => store.setVGap(store.vGap + 2)}>+</button>
        </div>
        {#if store.recents.length > 0}
          <div class="sep"></div>
          <div class="label">Recent</div>
          {#each store.recents as r (r.path)}
            <button
              class="recent"
              title={r.path}
              onclick={() => {
                menuOpen = false;
                void store.openPath(r.path);
              }}>{r.name}</button
            >
          {/each}
        {/if}
        <div class="sep"></div>
        <div class="about">Lighttable v0.1.0 — a Flux-repo sidecar</div>
      </div>
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 40px;
    padding: 0 12px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    flex: none;
  }
  .coll-anchor {
    position: relative;
  }
  .coll-name {
    font-weight: 600;
    color: var(--c-tx-hi);
    padding: 4px 8px;
    border-radius: var(--radius-s);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .coll-name:hover {
    background: var(--c-surface);
  }
  .sisters {
    left: 0;
    right: auto;
  }
  .sisters button.active {
    background: var(--c-accent-tint);
    color: var(--c-tx-hi);
  }
  .col-ctl {
    display: flex;
    align-items: center;
    gap: 2px;
    color: var(--c-tx-muted);
  }
  .col-ctl button {
    width: 22px;
    height: 22px;
    border-radius: var(--radius-s);
    color: var(--c-tx-2);
    line-height: 1;
  }
  .col-ctl button:hover {
    background: var(--c-surface);
  }
  .readout {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .search {
    width: 200px;
    height: 26px;
    padding: 0 8px;
    background: var(--c-surface);
    border: 1px solid var(--c-line);
    border-radius: var(--radius-s);
    outline: none;
  }
  .search:focus {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .grow {
    flex: 1;
  }
  .menu-anchor {
    position: relative;
  }
  .overflow {
    width: 26px;
    height: 26px;
    border-radius: var(--radius-s);
    color: var(--c-tx-2);
    font-size: 15px;
  }
  .overflow:hover {
    background: var(--c-surface);
  }
  .menu {
    position: absolute;
    right: 0;
    top: 30px;
    z-index: 20;
    min-width: 220px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--radius-m);
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .menu > button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border-radius: var(--radius-s);
    color: var(--c-tx);
  }
  .menu > button:hover:not(:disabled) {
    background: var(--c-ui-hover);
  }
  .menu > button:disabled {
    color: var(--c-tx-faint);
    cursor: default;
  }
  .menu .recent {
    color: var(--c-tx-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    height: 1px;
    background: var(--c-line);
    margin: 4px 6px;
  }
  .label {
    padding: 2px 10px;
    font-size: 11px;
    color: var(--c-tx-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .about {
    padding: 4px 10px;
    font-size: 11px;
    color: var(--c-tx-faint);
  }
  .gap-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    color: var(--c-tx-2);
  }
  .gap-name {
    flex: 1;
    font-size: 12px;
  }
  .gap-row .step {
    width: 20px;
    height: 20px;
    border-radius: var(--radius-s);
    color: var(--c-tx-2);
    line-height: 1;
    text-align: center;
  }
  .gap-row .step:hover {
    background: var(--c-ui-hover);
  }
  .gap-val {
    min-width: 22px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
</style>
