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
  import { pushToast, errMsg } from "../../../lib/toast";

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
  let saving = $state(false);

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
    if (!slideId || saving) return;
    saving = true;
    try {
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
    } catch (error) { pushToast("error", "Couldn't save the preset", { detail: errMsg(error) }); }
    finally { saving = false; }
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
      <input bind:this={inputEl} bind:value={name} disabled={saving} placeholder="name — e.g. titles/two-panel" spellcheck="false" onkeydown={onKey} />
      <button class="primary" onclick={doSave} disabled={saving || !name.trim()}>{saving ? "Saving media…" : "Save preset"}</button>
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
  /* a modal picker keeps the light scrim */
  .scrim {
    position: absolute; inset: 0; z-index: 60; background: rgba(0, 0, 0, .35);
    display: flex; align-items: center; justify-content: center;
  }
  .menu {
    width: min(560px, 86vw); max-height: min(520px, 82vh); overflow: hidden;
    display: flex; flex-direction: column; gap: 0; padding: 0;
    background: var(--c-surface); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel); box-shadow: var(--elev-2);
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased; color: var(--c-tx);
  }
  header { display: flex; align-items: center; justify-content: space-between; height: 30px; flex: 0 0 auto; padding: 0 6px 0 12px; border-bottom: 1px solid var(--c-line); }
  header strong { font: 600 12px var(--font-ui); color: var(--c-tx); }
  .x { width: 20px; height: 20px; padding: 0; border: 0; border-radius: var(--r-ui); background: transparent; color: var(--c-tx-muted); font-size: 13px; cursor: pointer; }
  .x:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  input {
    margin: 8px 10px 0; height: 24px; background: var(--c-bg); border: 1px solid var(--c-line-strong); color: var(--c-tx);
    border-radius: var(--r-ui); padding: 2px 6px; font: 12px var(--font-mono);
  }
  input:focus { border-color: var(--c-accent); outline: none; }
  /* Save preset is the panel's one primary */
  .primary {
    margin: 6px 10px 0; align-self: flex-start; height: 24px; padding: 3px 10px; font: 600 12px var(--font-ui);
    background: var(--c-accent); color: var(--c-on-accent); border: 1px solid var(--c-accent); border-radius: var(--r-ui); cursor: pointer;
  }
  .primary:hover:not(:disabled) { background: var(--c-accent-bright); border-color: var(--c-accent-bright); }
  .primary:disabled { opacity: .4; cursor: default; }
  .hint { color: var(--c-tx-muted); font-size: 11px; line-height: 1.5; padding: 6px 10px 0; }
  .grid { overflow-y: auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 8px 10px 10px; }
  .none { grid-column: 1 / -1; color: var(--c-tx-faint); padding: 18px 6px; text-align: center; }
  .card {
    position: relative; display: flex; flex-direction: column; gap: 3px;
    border: 1px solid var(--c-line); border-radius: var(--r-0); padding: 4px; background: var(--c-bg-raised);
  }
  .card.pickable { cursor: pointer; }
  .card.pickable:hover { border-color: var(--c-accent); background: var(--c-accent-tint-2); }
  .shot { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; border-radius: 0; background: var(--c-bg); border: 1px solid var(--c-line); }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-2); }
  .dir { color: var(--c-tx-faint); font: 10px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .del {
    position: absolute; top: 6px; right: 6px; width: 16px; height: 16px; line-height: 14px; padding: 0;
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-surface);
    color: var(--c-tx-muted); cursor: pointer; font-size: 11px; opacity: 0;
  }
  .card:hover .del { opacity: 1; }
  .del:hover { color: var(--c-danger); border-color: var(--c-danger); }
</style>
