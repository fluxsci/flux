<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { settings, settingsOpen, type Settings, type FluxFigMenuSize, type FluxFigMenuPos, type FluxFigMenuAnim } from "./settings";
  import { fileBridge } from "./project/types";

  // --- FluxLib location (desktop app only) ----------------------------------
  let libPath = "";
  let libNotice = "";
  let libBusy = false;
  let modalEl: HTMLDivElement | null = null;

  async function loadLib() {
    try {
      const p = await fileBridge()?.prefsGet?.();
      libPath = ((p?.fluxLibResolved ?? p?.fluxLibPath) as string) ?? "";
    } catch {
      libPath = "";
    }
  }

  async function revealLib() {
    if (libPath) await fileBridge()?.revealPath?.(libPath);
  }

  async function changeLib() {
    const fb = fileBridge();
    if (!fb?.openDirectory) {
      libNotice = "Changing the library folder needs the desktop app.";
      return;
    }
    libBusy = true;
    try {
      const dir = await fb.openDirectory("Choose your FluxLib folder");
      if (!dir) return;
      await fb.prefsSet?.({ fluxLibPath: dir });
      libPath = dir;
      libNotice = "Restart Flux to load references from the new location.";
    } catch (e) {
      libNotice = `Couldn't set the folder: ${(e as Error).message}`;
    } finally {
      libBusy = false;
    }
  }

  // Refresh the displayed path and move focus in whenever the panel opens; clear
  // the transient notice on close.
  $: if ($settingsOpen) {
    void loadLib();
    queueMicrotask(() => modalEl?.focus());
  } else {
    libNotice = "";
  }

  function onKey(e: KeyboardEvent) {
    if ($settingsOpen && e.key === "Escape") {
      e.preventDefault();
      settingsOpen.set(false);
    }
  }

  const sizes: { v: FluxFigMenuSize; l: string }[] = [
    { v: "sm", l: "Small" },
    { v: "md", l: "Medium" },
    { v: "lg", l: "Large" },
  ];
  const positions: { v: FluxFigMenuPos; l: string }[] = [
    { v: "center", l: "Center" },
    { v: "top", l: "Top" },
    { v: "left", l: "Left" },
    { v: "right", l: "Right" },
  ];
  const anims: { v: FluxFigMenuAnim; l: string }[] = [
    { v: "draw", l: "Draw-in" },
    { v: "fade", l: "Quick fade" },
  ];
  const marginScenes: { v: Settings["paperMarginScene"]; l: string }[] = [
    { v: "harmonograph", l: "Harmonograph" },
    { v: "neurons", l: "Neurons" },
    { v: "inkwind", l: "Ink wind" },
    { v: "loom", l: "Loom" },
    { v: "vines", l: "Vines" },
  ];
</script>

<svelte:window on:keydown={onKey} />

{#if $settingsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="bk" transition:fade={{ duration: 120 }} on:click={() => settingsOpen.set(false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      bind:this={modalEl}
      transition:scale={{ duration: 150, start: 0.96 }}
      on:click|stopPropagation>
      <h2>Settings</h2>

      <h3>Library folder</h3>
      <div class="libpath" title={libPath}>{libPath || "—"}</div>
      <div class="libbtns">
        <button class="ghost" on:click={revealLib} disabled={!libPath}>Reveal</button>
        <button class="ghost" on:click={changeLib} disabled={libBusy}>{libBusy ? "Choosing…" : "Change folder…"}</button>
      </div>
      {#if libNotice}<p class="hint">{libNotice}</p>{/if}

      <h3>Updates</h3>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.updateCheck}
          on:change={(e) => settings.update((v) => ({ ...v, updateCheck: e.currentTarget.checked }))}
        />
        Check for a newer version on launch (desktop app)
      </label>

      <h3>FluxFig Menu — size</h3>
      <div class="seg">
        {#each sizes as s}
          <button class:on={$settings.fluxFigMenuSize === s.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuSize: s.v }))}>{s.l}</button>
        {/each}
      </div>

      <h3>FluxFig Menu — position</h3>
      <div class="seg">
        {#each positions as p}
          <button class:on={$settings.fluxFigMenuPos === p.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuPos: p.v }))}>{p.l}</button>
        {/each}
      </div>

      <h3>FluxFig Menu — appearance</h3>
      <div class="seg">
        {#each anims as a}
          <button class:on={$settings.fluxFigMenuAnim === a.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuAnim: a.v }))}>{a.l}</button>
        {/each}
      </div>
      <p class="hint">{$settings.fluxFigMenuAnim === "draw" ? "The accent frame draws itself, then the controls rise in." : "The whole menu fades in at once — fastest."}</p>

      <h3>FluxFig Menu — opacity ({Math.round($settings.fluxFigMenuOpacity * 100)}%)</h3>
      <input
        type="range"
        min="0.6"
        max="1"
        step="0.01"
        value={$settings.fluxFigMenuOpacity}
        on:input={(e) => settings.update((v) => ({ ...v, fluxFigMenuOpacity: parseFloat(e.currentTarget.value) }))}
      />

      <h3>Palette</h3>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.flexokiDefault}
          on:change={(e) => settings.update((v) => ({ ...v, flexokiDefault: e.currentTarget.checked }))}
        />
        Include the Flexoki palette in new projects
      </label>

      <h3>Rulers &amp; grid</h3>
      <label class="chk">
        <input type="checkbox" checked={$settings.showRulers} on:change={(e) => settings.update((v) => ({ ...v, showRulers: e.currentTarget.checked }))} />
        Show rulers (<b>Shift+R</b>) — drag from a ruler to place a guide
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.showGrid} on:change={(e) => settings.update((v) => ({ ...v, showGrid: e.currentTarget.checked }))} />
        Show background grid
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.snapGrid} on:change={(e) => settings.update((v) => ({ ...v, snapGrid: e.currentTarget.checked }))} />
        Snap to grid
      </label>
      <label class="chk num">
        Grid size
        <input type="number" min="1" step="1" value={$settings.gridSize} on:change={(e) => settings.update((v) => ({ ...v, gridSize: Math.max(1, parseFloat(e.currentTarget.value) || 1) }))} />
        px
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.snapPixel} on:change={(e) => settings.update((v) => ({ ...v, snapPixel: e.currentTarget.checked }))} />
        Snap to pixel (round coords on commit — crisp export)
      </label>

      <h3>Paper — dynamic margin background</h3>
      <div class="seg scenes">
        {#each marginScenes as m}
          <button class:on={$settings.paperMarginScene === m.v} on:click={() => settings.update((v) => ({ ...v, paperMarginScene: m.v }))}>{m.l}</button>
        {/each}
      </div>

      <h3>Paper — dynamic panes</h3>
      <label class="chk num">
        Max panes open at once
        <input
          type="number"
          min="1"
          max="6"
          step="1"
          value={$settings.paperMaxMarginPanes}
          on:change={(e) => settings.update((v) => ({ ...v, paperMaxMarginPanes: Math.min(6, Math.max(1, Math.round(parseFloat(e.currentTarget.value) || 4))) }))}
        />
      </label>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.paperCleanMargin}
          on:change={(e) => settings.update((v) => ({ ...v, paperCleanMargin: e.currentTarget.checked }))}
        />
        Clean dynamic margin — close all panes when focus returns to the editor
      </label>

      <h3>Paper — caret glide ({$settings.paperCaretMs === 0 ? "instant" : `${$settings.paperCaretMs} ms`})</h3>
      <input
        type="range"
        min="0"
        max="140"
        step="10"
        value={$settings.paperCaretMs}
        on:input={(e) => settings.update((v) => ({ ...v, paperCaretMs: Math.round(parseFloat(e.currentTarget.value) || 0) }))}
      />
      <p class="hint">How smoothly the caret glides between positions. 70&nbsp;ms is the Flux default; lower feels snappier and 0 is instant (no glide).</p>

      <p class="tip">Open the FluxFig Menu with <b>F</b> while objects are selected.</p>
      <button class="close" on:click={() => settingsOpen.set(false)}>Done</button>
    </div>
  </div>
{/if}

<style>
  .bk {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 400;
  }
  .modal {
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 12px;
    padding: 22px 26px;
    width: 380px;
    color: var(--c-tx);
    box-shadow: var(--elev-3);
    font-family: var(--font-serif);
  }
  h2 {
    margin: 0 0 16px;
    font-size: 17px;
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    opacity: 0.55;
    margin: 16px 0 7px;
  }
  .seg {
    display: flex;
    gap: 6px;
  }
  .seg button {
    flex: 1;
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 6px;
    padding: 7px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .seg button.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .seg.scenes {
    flex-wrap: wrap;
  }
  .seg.scenes button {
    flex: 1 1 30%;
    font-size: 12px;
    padding: 6px 4px;
  }
  input[type="range"] {
    width: 100%;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .chk input {
    width: auto;
  }
  .chk.num input {
    width: 64px;
  }
  .libpath {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--c-tx-muted);
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line);
    border-radius: 6px;
    padding: 6px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .libbtns {
    display: flex;
    gap: 6px;
    margin-top: 7px;
  }
  .ghost {
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .ghost:hover:not(:disabled) {
    background: var(--c-ui-hover);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .modal:focus {
    outline: none;
  }
  .tip {
    font-size: 12px;
    opacity: 0.6;
    margin: 18px 0 14px;
  }
  .hint {
    font-size: 11px;
    opacity: 0.5;
    margin: 6px 0 0;
    line-height: 1.4;
  }
  .close {
    width: 100%;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 7px;
    padding: 9px;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
  }
</style>
