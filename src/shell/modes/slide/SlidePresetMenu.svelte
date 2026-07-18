<script lang="ts">
  // Slide-preset library menu — insert mode ("+ Preset" in the filmstrip)
  // browses <FluxConfig>/presets/slides and inserts the pick after the active
  // slide; save mode ("Save as preset…" in the Slide panel) names the active
  // slide into the library (slashes create folders, design-preset style).
  import {
    listSlidePresets,
    saveSlidePreset,
    deleteSlidePreset,
    insertSlidePreset,
    slidePresetThumb,
    type SlidePresetEntry,
  } from "../../../lib/slide/presetLib";
  import { pushToast } from "../../../lib/toast";

  let {
    mode,
    slideId = null,
    suggestedName = "",
    onClose,
  }: {
    mode: "insert" | "save";
    /** save: the slide being saved; insert: the slide to insert after. */
    slideId?: string | null;
    suggestedName?: string;
    onClose: () => void;
  } = $props();

  // $state.raw: entries are only ever REASSIGNED, and deep $state proxies
  // poison structuredClone downstream (insertSlideSnapshot) — the same trap
  // that froze Present on transform decks (f59ae44).
  let entries = $state.raw<SlidePresetEntry[]>([]);
  let loading = $state(true);
  let search = $state("");
  // svelte-ignore state_referenced_locally -- the initial value IS the intent (a seed the user edits)
  let name = $state(suggestedName ?? "");
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    void (async () => {
      entries = await listSlidePresets();
      loading = false;
    })();
  });
  $effect(() => {
    inputEl?.focus();
    inputEl?.select();
  });

  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return q ? entries.filter((e) => `${e.preset.name} ${e.rel}`.toLowerCase().includes(q)) : entries;
  });

  function doInsert(entry: SlidePresetEntry) {
    const nid = insertSlidePreset(entry, slideId);
    if (nid) pushToast("info", `Inserted "${entry.preset.name}"`);
    else pushToast("error", "Couldn't insert the preset (no deck loaded)");
    onClose();
  }
  async function doSave() {
    if (!slideId) return;
    const res = await saveSlidePreset(name, slideId);
    if (!res) {
      pushToast("error", "Couldn't save the preset", { detail: "Give it a name (slashes create folders)." });
      return;
    }
    pushToast("info", `Saved slide preset "${name}"`, {
      detail: res.missingAssets.length
        ? `${res.missingAssets.length} asset(s) had no loaded bytes and were not embedded.`
        : undefined,
    });
    onClose();
  }
  async function doDelete(entry: SlidePresetEntry, ev: MouseEvent) {
    ev.stopPropagation();
    if (await deleteSlidePreset(entry.rel)) entries = entries.filter((e) => e.rel !== entry.rel);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && mode === "save") {
      e.preventDefault();
      void doSave();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="scrim" onclick={onClose} onkeydown={onKey}>
  <div class="menu" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Slide presets" tabindex="-1">
    <header>
      <strong>{mode === "save" ? "Save slide as preset" : "Slide presets"}</strong>
      <button class="x" onclick={onClose} aria-label="Close">×</button>
    </header>
    {#if mode === "save"}
      <input bind:this={inputEl} bind:value={name} placeholder="name — e.g. titles/two-panel" spellcheck="false" onkeydown={onKey} />
      <button class="primary" onclick={doSave} disabled={!name.trim()}>Save preset</button>
      <div class="hint">Saved machine-wide to FluxConfig/presets/slides — animation, background and media travel with it.</div>
    {:else}
      <input bind:this={inputEl} bind:value={search} placeholder="search presets…" spellcheck="false" onkeydown={onKey} />
    {/if}
    <div class="grid">
      {#if loading}
        <div class="none">Loading…</div>
      {:else if !shown.length}
        <div class="none">{entries.length ? "No matches." : "No slide presets yet — save one from the Slide panel."}</div>
      {:else}
        {#each shown as entry (entry.rel)}
          <div class="card" class:pickable={mode === "insert"}
            onclick={() => mode === "insert" && doInsert(entry)}
            title={mode === "insert" ? `Insert "${entry.preset.name}" after the current slide` : entry.rel}>
            <img class="shot" src={slidePresetThumb(entry.preset)} alt={entry.preset.name} />
            <span class="nm">{entry.preset.name}</span>
            {#if entry.rel.includes("/")}<span class="dir">{entry.rel.split("/").slice(0, -1).join("/")}</span>{/if}
            <button class="del" onclick={(e) => doDelete(entry, e)} title="Delete preset" aria-label="Delete preset">×</button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: absolute; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.35);
    display: flex; align-items: center; justify-content: center;
  }
  .menu {
    width: min(560px, 86vw); max-height: min(520px, 82vh); overflow: hidden;
    display: flex; flex-direction: column; gap: 8px; padding: 12px;
    background: var(--c-bg-raised); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
    font-size: 12px; color: var(--c-tx);
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  header strong { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--c-tx-2); }
  .x { border: none; background: transparent; color: var(--c-tx-muted); font-size: 15px; cursor: pointer; }
  .x:hover { color: var(--c-tx-hi); }
  input {
    background: var(--c-bg); border: 1px solid var(--c-line-strong); color: var(--c-tx);
    border-radius: 4px; padding: 5px 8px; font-size: 12px; width: 100%;
  }
  .primary {
    background: var(--c-accent); color: var(--c-on-accent, #100f0f); border: none;
    border-radius: 5px; padding: 6px 10px; font-size: 12px; cursor: pointer;
  }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .hint { color: var(--c-tx-muted); font-size: 11px; }
  .grid {
    overflow-y: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    padding: 2px;
  }
  .none { grid-column: 1 / -1; color: var(--c-tx-faint); font-style: italic; padding: 18px 6px; text-align: center; }
  .card {
    position: relative; display: flex; flex-direction: column; gap: 3px;
    border: 1px solid var(--c-line); border-radius: var(--r-2); padding: 5px;
  }
  .card.pickable { cursor: pointer; }
  .card.pickable:hover { border-color: var(--c-accent); background: var(--c-accent-tint-2); }
  .shot { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 3px; background: var(--c-bg); border: 1px solid var(--c-line); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-2); }
  .dir { color: var(--c-tx-faint); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .del {
    position: absolute; top: 7px; right: 7px; width: 17px; height: 17px; line-height: 15px;
    border: none; border-radius: 3px; background: color-mix(in oklab, var(--c-bg, #100f0f) 72%, transparent);
    color: var(--c-tx-muted); cursor: pointer; font-size: 12px; opacity: 0;
  }
  .card:hover .del { opacity: 1; }
  .del:hover { color: var(--c-danger, #d14d41); }
</style>
