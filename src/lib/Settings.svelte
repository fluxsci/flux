<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { settings, settingsOpen, type FluxFigMenuSize, type FluxFigMenuPos, type FluxFigMenuAnim } from "./settings";

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
</script>

{#if $settingsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="bk" transition:fade={{ duration: 120 }} on:click={() => settingsOpen.set(false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="modal" transition:scale={{ duration: 150, start: 0.96 }} on:click|stopPropagation>
      <h2>Settings</h2>

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
