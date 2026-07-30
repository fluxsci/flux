<script lang="ts">
  // Zotero connection panel — connect FluxLib to a Better BibTeX "Keep updated"
  // auto-export and sync from it (see zoteroSyncJob.svelte.ts for the engine;
  // this dialog is only settings + status). Modal idiom mirrors ImportDialog.
  import { fileBridge } from "../../../lib/project/types";
  import { zoteroSyncJob } from "../../../lib/references/zoteroSyncJob.svelte";
  import type { ZoteroSettings } from "../../../lib/references/zoteroSettings";

  let {
    projectRoot = null,
    onClose,
  }: {
    projectRoot?: string | null;
    onClose: () => void;
  } = $props();

  // Draft (connect form) state — seeded from stored settings when editing.
  let draftBib = $state(zoteroSyncJob.settings?.bibPath ?? "");
  let draftDataDir = $state(zoteroSyncJob.settings?.dataDir ?? "");
  let draftAttach = $state<"copy" | "link">(zoteroSyncJob.settings?.attach ?? "copy");
  let draftAuto = $state(zoteroSyncJob.settings?.auto ?? true);
  let editing = $state(!zoteroSyncJob.settings); // no settings yet -> straight to the form

  const connected = $derived(zoteroSyncJob.settings !== null);

  async function chooseBib() {
    const fb = fileBridge();
    if (!fb?.openFiles) return;
    const picked = await fb.openFiles([{ name: "BibTeX", extensions: ["bib"] }]);
    if (picked?.[0]) {
      draftBib = picked[0];
      // Default the data dir to the .bib's parent — the common case is exporting
      // into the Zotero data folder itself; the user can still point elsewhere.
      if (!draftDataDir) draftDataDir = draftBib.replace(/[/\\][^/\\]*$/, "");
    }
  }
  async function chooseDataDir() {
    const fb = fileBridge();
    if (!fb?.openDirectory) return;
    const dir = await fb.openDirectory("Locate your Zotero data folder (its 'storage' holds the PDFs)");
    if (dir) draftDataDir = dir;
  }

  async function connect() {
    if (!draftBib.trim()) return;
    const next: ZoteroSettings = {
      bibPath: draftBib.trim(),
      dataDir: draftDataDir.trim() || undefined,
      attach: draftAttach,
      auto: draftAuto,
    };
    await zoteroSyncJob.saveSettings(next);
    editing = false;
    // Re-arm the file watcher so BBT rewrites sync live from now on (the watch
    // targets are resolved when the watcher starts — see main.cjs watch:setRoot).
    const fb = fileBridge();
    if (projectRoot) void fb?.watchRoot?.(projectRoot);
    void zoteroSyncJob.sync(); // first sync right away — the point of connecting
  }

  async function toggleAuto() {
    const s = zoteroSyncJob.settings;
    if (!s) return;
    await zoteroSyncJob.saveSettings({ ...s, auto: !s.auto });
  }

  async function disconnect() {
    await zoteroSyncJob.disconnect();
    draftBib = "";
    draftDataDir = "";
    editing = true;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }

  const lastRunLabel = $derived.by(() => {
    const r = zoteroSyncJob.lastRun;
    if (!r) return "";
    const t = new Date(r.at);
    const hh = `${t.getHours()}`.padStart(2, "0");
    const mm = `${t.getMinutes()}`.padStart(2, "0");
    return r.error ? `${hh}:${mm} — ${r.error}` : `${hh}:${mm} — ${r.line}`;
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="card" role="dialog" aria-modal="true" aria-label="Zotero" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <header class="ih">
      <span class="ihh">Zotero</span>
      {#if connected && !editing}<span class="ihf">{zoteroSyncJob.settings?.bibPath}</span>{/if}
    </header>

    {#if editing}
      <div class="body">
        <p class="muted">
          Flux pulls new references (and their PDFs) from a Zotero auto-export — one-way and additive; nothing in
          Zotero is ever changed. In Zotero, install the <b>Better BibTeX</b> plugin, right-click your library →
          <b>Export Library…</b> → format <b>Better BibTeX</b>, tick <b>Keep updated</b>, and save the .bib file.
          Then point Flux at it:
        </p>
        <div class="row">
          <button class="ghost" onclick={chooseBib}>Choose .bib…</button>
          <span class="ztxt">{draftBib || "the Better BibTeX auto-export file"}</span>
        </div>
        <div class="row">
          <button class="ghost" onclick={chooseDataDir}>Zotero folder…</button>
          <span class="ztxt">{draftDataDir || "for PDFs stored relative to Zotero (usually ~/Zotero)"}</span>
        </div>
        <div class="row radios">
          <label><input type="radio" bind:group={draftAttach} value="copy" /> Copy PDFs into FluxLib <span class="hint">self-contained — FluxLib alone is a complete backup</span></label>
          <label><input type="radio" bind:group={draftAttach} value="link" /> Link to Zotero's PDFs <span class="hint">one copy on disk — papers open from Zotero's folder, which must stay put</span></label>
        </div>
        <label class="row"><input type="checkbox" bind:checked={draftAuto} /> Sync automatically (on startup, and live when the export changes)</label>
      </div>
      <footer class="if">
        {#if connected}<button class="ghost" onclick={() => (editing = false)}>Cancel</button>{/if}
        <button class="prim" disabled={!draftBib.trim()} onclick={connect}>Connect &amp; sync</button>
      </footer>
    {:else}
      <div class="body">
        <div class="kv"><span class="k">Export</span><span class="v">{zoteroSyncJob.settings?.bibPath}</span></div>
        <div class="kv"><span class="k">Zotero folder</span><span class="v">{zoteroSyncJob.settings?.dataDir ?? "—"}</span></div>
        <div class="kv"><span class="k">PDFs</span><span class="v">{zoteroSyncJob.settings?.attach === "link" ? "linked (one copy, in Zotero's folder)" : "copied into FluxLib"}</span></div>
        <label class="row"><input type="checkbox" checked={zoteroSyncJob.settings?.auto} onchange={toggleAuto} /> Sync automatically</label>
        {#if lastRunLabel}
          <p class="muted" class:err={!!zoteroSyncJob.lastRun?.error}>Last sync {lastRunLabel}</p>
        {/if}
      </div>
      <footer class="if">
        <button class="ghost" onclick={disconnect} title="Forget the connection. Everything already synced stays in FluxLib.">Disconnect</button>
        <button class="ghost" onclick={() => (editing = true)}>Settings…</button>
        <button class="prim" disabled={zoteroSyncJob.running} onclick={() => void zoteroSyncJob.sync()}>
          {zoteroSyncJob.running ? "Syncing…" : "Sync now"}
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--c-bg) 70%, transparent);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .card {
    width: min(560px, 92vw);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 10px);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }
  .ih {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--c-line);
  }
  .ihh {
    font-weight: 600;
    color: var(--c-tx);
  }
  .ihf {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    padding: 14px 16px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .muted {
    color: var(--c-tx-muted);
    font-size: var(--ts-sm);
    margin: 0;
  }
  .err {
    color: var(--c-danger, #c0392b);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--ts-sm);
    color: var(--c-tx);
  }
  .row.radios {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .ztxt {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--c-tx-faint);
    font-size: var(--ts-xs);
  }
  .kv {
    display: flex;
    gap: 10px;
    font-size: var(--ts-sm);
  }
  .k {
    color: var(--c-tx-muted);
    min-width: 92px;
  }
  .v {
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .if {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--c-line);
  }
  button.ghost,
  button.prim {
    font: inherit;
    font-size: var(--ts-sm);
    padding: 5px 12px;
    border-radius: var(--r-1, 6px);
    cursor: pointer;
  }
  button.ghost {
    background: transparent;
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
  }
  button.prim {
    background: var(--c-accent);
    border: 1px solid var(--c-accent);
    color: var(--c-bg);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  input[type="radio"],
  input[type="checkbox"] {
    accent-color: var(--c-accent);
  }
</style>
