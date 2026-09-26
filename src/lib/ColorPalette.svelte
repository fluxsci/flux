<script lang="ts">
  import { editSession } from "./interact/editSession";
  import { project } from "./store";
  import { colorTarget, applyColor, addRecentColor } from "./colors";
  import { importPalette } from "./io";
  import ColorField from "./ColorField.svelte";

  let error = "";

  async function onImport() {
    error = "";
    try {
      await importPalette();
    } catch (e) {
      error = (e as Error).message ?? "Import failed";
    }
  }

  // Every swatch click is one edit session (one undo), recents included.
  function pick(hex: string, recent = true) {
    const session = editSession();
    session.run(() => {
      applyColor(hex, undefined, true);
      if (recent) addRecentColor(hex, true);
    });
    session.finish();
  }
</script>

<section>
  <div class="head">
    <h4>Colors</h4>
    <div class="seg">
      <button class:on={$colorTarget === "fill"} on:click={() => colorTarget.set("fill")}>Fill</button>
      <button class:on={$colorTarget === "stroke"} on:click={() => colorTarget.set("stroke")}>Stroke</button>
    </div>
  </div>

  <!-- "No paint" — sets the targeted paint to the literal "none" (outline-only
       shapes / borderless fills). Deliberately not added to recents. -->
  <div class="nonerow">
    <button
      class="sw none-sw"
      title={$colorTarget === "fill" ? "Remove fill (outline only)" : "Remove stroke (no outline)"}
      aria-label={`No ${$colorTarget}`}
      on:click={() => pick("none", false)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><line x1="3.5" y1="12.5" x2="12.5" y2="3.5" stroke="#d14d41" stroke-width="1.8" stroke-linecap="round" /></svg>
    </button>
    <span class="nonelbl">No {$colorTarget}</span>
  </div>

  {#if $project.palette.length}
    <div class="recent">
      {#each $project.palette as c}
        <button class="sw" style={`background:${c}`} title={c} on:click={() => pick(c)} aria-label={c}></button>
      {/each}
    </div>
  {/if}

  {#if $project.colorGroups?.length}
    <div class="groups">
      {#each $project.colorGroups as g}
        <div class="group">
          <div class="glabel">{g.name}</div>
          <div class="shades">
            {#each g.swatches as s}
              <button
                class="sw"
                style={`background:${s.hex}`}
                title={`${s.name}  ${s.hex}`}
                on:click={() => pick(s.hex)}
                aria-label={`${g.name} ${s.name}`}
              ></button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <p class="hint">No palette imported yet.</p>
  {/if}

  <div class="actions">
    <button class="import" on:click={onImport}>Import palette…</button>
    <!-- ColorField, never a native <input type="color">: its eyedropper segfaults Electron on Linux/Wayland. -->
    <ColorField compact title="Add custom colour" label="Add custom colour" value="#888888" onchange={(hex) => pick(hex)} />
  </div>
  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  section {
    padding: 8px 0 10px;
    font-family: var(--font-ui);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  h4 {
    margin: 0;
    font: 600 10.5px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--c-tx-muted);
  }
  .seg {
    display: flex;
  }
  .seg button {
    height: 22px;
    background: transparent;
    color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong);
    padding: 0 8px;
    font: 11px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .seg button:first-child {
    border-radius: var(--r-ui) 0 0 var(--r-ui);
  }
  .seg button:last-child {
    border-radius: 0 var(--r-ui) var(--r-ui) 0;
    border-left: none;
  }
  .seg button.on {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
  .nonerow {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
  }
  .none-sw {
    background: var(--c-surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }
  .nonelbl {
    font-size: 11px;
    color: var(--c-tx-muted);
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-bottom: 8px;
  }
  .groups {
    max-height: 260px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .group {
    margin-bottom: 6px;
  }
  .glabel {
    font: 9.5px var(--font-mono);
    color: var(--c-tx-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 3px;
  }
  .shades {
    display: grid;
    grid-template-columns: repeat(auto-fill, 16px);
    gap: 3px;
  }
  .sw {
    width: 16px;
    height: 16px;
    border-radius: var(--r-ui);
    border: 1px solid color-mix(in oklab, var(--c-tx-hi) 12%, transparent);
    padding: 0;
    cursor: var(--cursor-cross-hover);
  }
  .recent .sw {
    width: 20px;
    height: 20px;
  }
  .sw:hover {
    outline: 2px solid var(--c-accent);
    outline-offset: 1px;
    z-index: 1;
  }
  .actions {
    display: flex;
    gap: 4px;
    margin-top: 8px;
    align-items: stretch;
  }
  .import {
    flex: 1;
    height: 24px;
    background: transparent;
    color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .import:hover {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .hint {
    font-size: 11px;
    color: var(--c-tx-muted);
    margin: 4px 0;
  }
  .err {
    color: var(--c-danger);
    font-size: 11px;
    margin: 6px 0 0;
  }
</style>
