<script lang="ts">
  import {
    activeTool,
    viewport,
    undo,
    redo,
    dirty,
    projectDir,
    embeddedProjectRoot,
    type Tool,
  } from "./store";
  import { importAssets, openProject, saveProject } from "./io";
  import { settingsOpen, settings } from "./settings";

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

<header class="toolbar">
  <span class="brand">Figure{$dirty ? " •" : ""}</span>

  <div class="group">
    {#if !$embeddedProjectRoot}
      <button on:click={openProject} title="Open (Ctrl+O)">Open</button>
      <button on:click={saveProject} title="Save (Ctrl+S)">Save</button>
    {/if}
    <button on:click={importAssets} title="Import PNG/SVG (Ctrl+I)">Import</button>
  </div>

  <div class="sep"></div>

  <div class="group tools">
    {#each tools as t}
      <button
        class:active={$activeTool === t.id}
        title={`${t.label} (${t.key})`}
        on:click={() => activeTool.set(t.id)}>{t.label}</button
      >
    {/each}
  </div>

  <div class="sep"></div>
  <div class="group">
    <button on:click={undo} title="Undo (Ctrl+Z)">↶</button>
    <button on:click={redo} title="Redo (Ctrl+Shift+Z)">↷</button>
    <button
      class:active={$settings.showRulers}
      title="Rulers (Shift+R)"
      on:click={() => settings.update((s) => ({ ...s, showRulers: !s.showRulers }))}>Rulers</button
    >
  </div>

  <span class="spacer"></span>
  {#if $embeddedProjectRoot}
    <span class="path">{$dirty ? "saving…" : "saved to project"}</span>
  {:else}
    <span class="path">{$projectDir ?? "unsaved"}</span>
  {/if}
  <div class="group zoom">
    <button on:click={() => setZoom(Math.max(0.05, $viewport.zoom / 1.25))}>−</button>
    <span class="zoomval">{Math.round($viewport.zoom * 100)}%</span>
    <button on:click={() => setZoom(Math.min(16, $viewport.zoom * 1.25))}>+</button>
    <button on:click={() => setZoom(1)}>100%</button>
  </div>
  <button class="gear" title="Settings" on:click={() => settingsOpen.set(true)}>⚙</button>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    flex-wrap: nowrap;
    color: var(--c-tx);
  }
  .brand {
    font-family: var(--font-serif);
    font-weight: 600;
    margin-right: 4px;
    color: var(--c-tx-hi);
  }
  .group {
    display: flex;
    gap: 4px;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--c-line-strong);
  }
  .spacer {
    flex: 1;
  }
  .path {
    font-size: 11px;
    opacity: 0.5;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .zoomval {
    font-variant-numeric: tabular-nums;
    min-width: 42px;
    text-align: center;
    font-size: 12px;
  }
  button {
    background: var(--c-ui);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    padding: 4px 9px;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover {
    background: var(--c-ui-hover);
  }
  button.active {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
</style>
