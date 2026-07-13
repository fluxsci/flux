<script lang="ts">
  // Design-preset picker (Ctrl+P) — a grid quick-open over the machine-global
  // preset library (<FluxConfig>/presets/designs). Two modes via the
  // presetPicker store:
  //   insert — browse/search the grid, Enter/click drops the preset into the
  //            active figure at the viewport centre.
  //   save   — name the selected element (slashes create folders), Enter/Save
  //            writes it; the grid shows the existing library for context and
  //            folder chips append their prefix to the name.
  import { fade, scale } from "svelte/transition";
  import {
    presetPicker,
    listDesignPresets,
    saveDesignPreset,
    deleteDesignPreset,
    insertPreset,
    presetThumb,
    presetElements,
    presetableSelection,
    type PresetEntry,
  } from "./presets";
  import { project, findElement } from "./store";
  import { pushToast } from "./toast";

  let entries: PresetEntry[] = [];
  let search = "";
  let index = 0;
  let name = "";
  let nameEl: HTMLInputElement;
  let searchEl: HTMLInputElement;
  let loading = false;

  $: state = $presetPicker;
  $: saveEls =
    state?.mode === "save"
      ? state.elementIds.map((id) => findElement($project, id)?.element).filter((e) => !!e)
      : [];
  $: q = search.trim().toLowerCase();
  $: shown = q
    ? entries.filter((e) => `${e.preset.name} ${e.rel}`.toLowerCase().includes(q))
    : entries;
  $: if (index >= shown.length) index = Math.max(0, shown.length - 1);
  $: folders = [...new Set(entries.map((e) => e.rel.split("/").slice(0, -1).join("/")).filter(Boolean))].sort();

  let prevOpen = false;
  $: {
    if (state && !prevOpen) void open();
    prevOpen = !!state;
  }
  async function open() {
    search = "";
    index = 0;
    loading = true;
    entries = await listDesignPresets();
    loading = false;
    if (state?.mode === "save") {
      name = saveEls.length > 1 ? defaultName("group") : saveEls.length ? defaultName(saveEls[0].type) : "";
      requestAnimationFrame(() => {
        nameEl?.focus();
        nameEl?.select();
      });
    } else {
      requestAnimationFrame(() => searchEl?.focus());
    }
  }
  function defaultName(kind: string): string {
    const n = entries.filter((e) => {
      const els = presetElements(e.preset);
      return kind === "group" ? els.length > 1 : els.length === 1 && els[0].type === kind;
    }).length;
    return n ? `${kind}-${n + 1}` : kind;
  }

  function close() {
    presetPicker.set(null);
  }

  async function doSave() {
    if (state?.mode !== "save" || !presetableSelection(saveEls)) {
      pushToast("error", "Presets take one primitive, or a group of primitives + text");
      return;
    }
    const rel = await saveDesignPreset(name, state.elementIds);
    if (rel) {
      pushToast("success", `Preset saved`, { detail: rel });
      close();
    } else {
      pushToast("error", "Could not save preset", { detail: "Check the name — slashes make folders" });
    }
  }

  function doInsert(entry: PresetEntry) {
    const ids = insertPreset(entry, { w: window.innerWidth, h: window.innerHeight });
    if (ids.length) close();
    else pushToast("info", "Open a figure first — presets insert into the active figure");
  }

  async function doDelete(e: MouseEvent, entry: PresetEntry) {
    e.stopPropagation();
    if (await deleteDesignPreset(entry.rel)) entries = entries.filter((x) => x.rel !== entry.rel);
  }

  const COLS = 4;
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (state?.mode === "save") {
      if (e.key === "Enter") {
        e.preventDefault();
        void doSave();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = shown[index];
      if (entry) doInsert(entry);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      index = Math.min(shown.length - 1, index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      index = Math.max(0, index - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      index = Math.min(shown.length - 1, index + COLS);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      index = Math.max(0, index - COLS);
    }
  }
</script>

{#if state}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pp-backdrop" transition:fade={{ duration: 100 }} on:pointerdown={close}></div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
  <div
    class="pp"
    transition:scale={{ duration: 120, start: 0.97 }}
    on:pointerdown|stopPropagation
    on:keydown={onKey}
    tabindex="-1"
  >
    <header>
      <h3>{state.mode === "save" ? "Save as preset" : "Insert preset"}</h3>
      <span class="hint">{state.mode === "save" ? "Enter saves · slashes make folders" : "Enter inserts · Esc closes"}</span>
    </header>

    {#if state.mode === "save"}
      <div class="save-row">
        {#if saveEls.length}
          <div class="save-thumb"><img src={presetThumb(saveEls)} alt="preset preview" /></div>
        {/if}
        <input
          bind:this={nameEl}
          bind:value={name}
          class="name-in"
          placeholder="name — or folder/name"
          spellcheck="false"
        />
        <button class="save-btn" on:click={doSave}>Save</button>
      </div>
      {#if folders.length}
        <div class="folders">
          {#each folders as f}
            <button class="chip" on:click={() => { name = `${f}/${name.split("/").pop() ?? ""}`; nameEl?.focus(); }}>{f}/</button>
          {/each}
        </div>
      {/if}
      <div class="sep">Library</div>
    {:else}
      <input
        bind:this={searchEl}
        bind:value={search}
        class="search"
        placeholder="Search presets…"
        spellcheck="false"
      />
    {/if}

    <div class="grid" class:dim={state.mode === "save"}>
      {#if loading}
        <div class="empty">Loading…</div>
      {:else if !shown.length}
        <div class="empty">
          {entries.length ? "No preset matches" : "No presets yet — select a shape and use the FluxFig menu's “save as preset”"}
        </div>
      {:else}
        {#each shown as entry, i (entry.rel)}
          <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
          <div
            class="card"
            class:active={state.mode === "insert" && i === index}
            on:pointerenter={() => (index = i)}
            on:click={() => state.mode === "insert" && doInsert(entry)}
          >
            <div class="thumb"><img src={presetThumb(presetElements(entry.preset))} alt={entry.preset.name} /></div>
            <div class="meta">
              <span class="nm">{entry.preset.name}{presetElements(entry.preset).length > 1 ? ` (group·${presetElements(entry.preset).length})` : ""}</span>
              {#if entry.rel.includes("/")}<span class="dir">{entry.rel.split("/").slice(0, -1).join("/")}</span>{/if}
            </div>
            <button class="del" title="Delete preset" on:click={(e) => doDelete(e, entry)}>×</button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .pp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.32);
    z-index: 320;
  }
  .pp {
    position: fixed;
    left: 50%;
    top: 12vh;
    transform: translateX(-50%);
    width: min(620px, 92vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 10px;
    box-shadow: var(--elev-3);
    z-index: 321;
    padding: 14px;
    outline: none;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  h3 {
    margin: 0;
    font-size: 15px;
  }
  .hint {
    font-size: 11px;
    color: var(--c-tx-muted);
  }
  .search,
  .name-in {
    width: 100%;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 7px;
    color: var(--c-tx);
    padding: 8px 10px;
    font-size: 14px;
    outline: none;
    margin-bottom: 10px;
  }
  .search:focus,
  .name-in:focus {
    border-color: var(--c-accent);
  }
  .save-row {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 8px;
  }
  .save-row .name-in {
    margin-bottom: 0;
    flex: 1;
  }
  .save-thumb {
    width: 52px;
    height: 52px;
    flex: none;
    border: 1px solid var(--c-line);
    border-radius: 7px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .save-thumb img {
    max-width: 90%;
    max-height: 90%;
  }
  .save-btn {
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 7px;
    padding: 8px 16px;
    font-size: 14px;
    cursor: pointer;
  }
  .folders {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .chip {
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    border-radius: 999px;
    color: var(--c-tx);
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--c-accent);
  }
  .sep {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.5;
    margin: 4px 0 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    overflow-y: auto;
    padding: 2px;
  }
  .grid.dim {
    opacity: 0.75;
  }
  .card {
    position: relative;
    border: 1px solid var(--c-line);
    border-radius: 8px;
    padding: 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--c-bg-raised);
  }
  .card.active {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .thumb {
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    border-radius: 5px;
    overflow: hidden;
  }
  .thumb img {
    max-width: 92%;
    max-height: 92%;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .nm {
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dir {
    font-size: 10.5px;
    color: var(--c-tx-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .del {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
  }
  .card:hover .del {
    opacity: 1;
  }
  .del:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 26px 10px;
    color: var(--c-tx-muted);
    font-size: 13px;
  }
</style>
