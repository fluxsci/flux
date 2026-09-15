<script lang="ts">
  import { getContext } from "svelte";
  import {
    activeTool,
    viewport,
    undo,
    redo,
    dirty,
    historyAvailability,
    projectDir,
    embeddedProjectRoot,
    importerOpen,
    type Tool,
  } from "./store";
  import { importAssets, openProject, saveProject } from "./io";
  import type { AutosaveStatus } from "./autosave";
  export let saveStatus: AutosaveStatus = "idle";
  export let saveError: string | null = null;
  export let retrySave: (() => void) | null = null;
  import { settingsOpen, settings } from "./settings";

  // Slide-migration: the same toolbar serves both editors; only the mode title
  // differs (subtly accented in Slide mode — the sanctioned differentiator).
  const slideMode = (getContext<"figure" | "slide" | undefined>("flux-editor-mode") ?? "figure") === "slide";

  const tools: { id: Tool; label: string; key: string }[] = [
    { id: "select", label: "Select", key: "V" },
    { id: "scale", label: "Scale", key: "K" },
    { id: "hand", label: "Pan", key: "H" },
    { id: "text", label: "Text", key: "T" },
    { id: "rect", label: "Rect", key: "R" },
    { id: "ellipse", label: "Ellipse", key: "O" },
    { id: "line", label: "Line", key: "L" },
    { id: "arrow", label: "Arrow", key: "A" },
    { id: "pen", label: "Pen", key: "P" },
  ];

  function setZoom(z: number) {
    viewport.update((v) => ({ ...v, zoom: z }));
  }
</script>

<!-- The editor's top strip (2026-09-15 surface redesign): one flat 34px bar on
     the raised surface, groups separated by hairlines, square controls, the
     active tool as a quiet accent tint. -->
<header class="toolbar">
  <span class="brand" class:slide={slideMode}>{slideMode ? "Slide" : "Figure"}{$dirty ? " •" : ""}</span>

  <div class="group">
    {#if !$embeddedProjectRoot}
      <button on:click={openProject} title="Open (Ctrl+O)">Open</button>
      <button on:click={saveProject} title="Save (Ctrl+S)">Save</button>
    {/if}
    <button on:click={importAssets} title="Import PNG/SVG (Ctrl+Shift+K)">Import</button>
    <button on:click={() => importerOpen.set(true)} title={slideMode ? "Browse project plots and MP4/MOV clips (Alt+G)" : "Plot gallery (Alt+G)"}>{slideMode ? "Plots & videos" : "Gallery"}</button>
  </div>

  <div class="sep"></div>

  <div class="group tools">
    {#each tools as t}
      <button
        class:active={$activeTool === t.id}
        title={`${t.label} (${t.key})`}
        on:click={() => activeTool.set(t.id)}>{t.label}<kbd>{t.key}</kbd></button
      >
    {/each}
  </div>

  <div class="sep"></div>
  <div class="group">
    <button disabled={!$historyAvailability.undo} on:click={undo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
    <button disabled={!$historyAvailability.redo} on:click={redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
    <button
      class:active={$settings.showRulers}
      title="Rulers (Shift+R)"
      on:click={() => settings.update((s) => ({ ...s, showRulers: !s.showRulers }))}>Rulers</button
    >
  </div>

  <span class="spacer"></span>
  {#if $embeddedProjectRoot}
    {#if saveError}
      <button class="save-error" title={saveError} on:click={() => retrySave?.()}>Unsaved · Retry</button>
    {:else}
      <span class="path" title={saveStatus === "saving" ? "Saving changes" : $dirty ? "Changes waiting to save" : "Saved to project"}>{saveStatus === "saving" ? "saving…" : $dirty ? "unsaved changes" : "saved to project"}</span>
    {/if}
  {:else}
    <span class="path">{$projectDir ?? "unsaved"}</span>
  {/if}
  <div class="group zoom">
    <button title="Zoom out" aria-label="Zoom out" on:click={() => setZoom(Math.max(0.05, $viewport.zoom / 1.25))}>−</button>
    <span class="zoomval">{Math.round($viewport.zoom * 100)}%</span>
    <button title="Zoom in" aria-label="Zoom in" on:click={() => setZoom(Math.min(16, $viewport.zoom * 1.25))}>+</button>
    <button on:click={() => setZoom(1)}>100%</button>
  </div>
  <button class="gear" title="Settings" on:click={() => settingsOpen.set(true)}>⚙</button>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 3px 8px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    flex-wrap: wrap;
    container-type: inline-size;
    color: var(--c-tx);
    font-family: var(--font-ui);
    font-size: 12px;
    -webkit-font-smoothing: antialiased;
  }
  .brand {
    font: 600 12px var(--font-ui);
    letter-spacing: 0.02em;
    margin-right: 4px;
    color: var(--c-tx-hi);
  }
  .brand.slide {
    color: var(--c-accent-bright);
  }
  .save-error { color: var(--c-danger); font-size: 11px; }
  button:disabled { opacity: 0.35; cursor: default; }
  .group {
    display: flex;
    gap: 2px;
  }
  /* Tools form ONE joined segment (shared hairlines, outer radius only). */
  .group.tools { gap: 0; }
  .group.tools button { border-radius: 0; margin-left: -1px; }
  .group.tools button:first-child { border-radius: var(--r-ui) 0 0 var(--r-ui); margin-left: 0; }
  .group.tools button:last-child { border-radius: 0 var(--r-ui) var(--r-ui) 0; }
  .group.tools button.active { position: relative; z-index: 1; }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--c-line-strong);
    margin: 0 2px;
  }
  .spacer {
    flex: 1 1 0;
  }
  .path {
    font: 11px var(--font-mono);
    color: var(--c-tx-muted);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
  }
  .zoomval {
    font: 11px var(--font-mono);
    font-variant-numeric: tabular-nums;
    min-width: 42px;
    text-align: center;
    color: var(--c-tx-2);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    background: transparent;
    color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    padding: 0 8px;
    font: 12px var(--font-ui);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  button.active {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  kbd {
    font: 600 9.5px var(--font-mono);
    color: var(--c-tx-muted);
    text-transform: uppercase;
  }
  button.active kbd { color: var(--c-accent); }
  .gear { padding: 0 6px; font-size: 13px; }
  @media (max-width: 1100px) {
    .toolbar { gap: 4px; padding: 3px 6px; }
    .toolbar button { padding: 0 6px; }
    kbd { display: none; }
    .path { max-width: 90px; }
  }
</style>
