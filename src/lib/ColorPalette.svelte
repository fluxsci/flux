<script lang="ts">
  import { project } from "./store";
  import { colorTarget, applyColor, addRecentColor } from "./colors";
  import { importPalette } from "./io";

  let error = "";

  async function onImport() {
    error = "";
    try {
      await importPalette();
    } catch (e) {
      error = (e as Error).message ?? "Import failed";
    }
  }

  function pick(hex: string) {
    applyColor(hex);
    addRecentColor(hex);
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

  {#if $project.palette.length}
    <div class="recent">
      {#each $project.palette as c}
        <button class="sw" style={`background:${c}`} title={c} on:click={() => applyColor(c)} aria-label={c}></button>
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
    <label class="add" title="Add custom colour">
      +
      <input type="color" on:change={(e) => pick(e.currentTarget.value)} />
    </label>
  </div>
  {#if error}<p class="err">{error}</p>{/if}
</section>

<style>
  section {
    padding: 10px 0;
    border-bottom: 1px solid var(--c-line);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  h4 {
    margin: 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.6;
  }
  .seg {
    display: flex;
  }
  .seg button {
    background: var(--c-ui);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .seg button:first-child {
    border-radius: 5px 0 0 5px;
  }
  .seg button:last-child {
    border-radius: 0 5px 5px 0;
    border-left: none;
  }
  .seg button.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }
  .groups {
    max-height: 260px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .group {
    margin-bottom: 8px;
  }
  .glabel {
    font-size: 10px;
    opacity: 0.5;
    text-transform: capitalize;
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
    border-radius: 3px;
    border: 1px solid #00000044;
    padding: 0;
    cursor: pointer;
    transition: transform 0.06s;
  }
  .recent .sw {
    width: 22px;
    height: 22px;
    border-radius: 4px;
  }
  .sw:hover {
    transform: scale(1.18);
    border-color: var(--c-tx-hi);
    z-index: 1;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    align-items: stretch;
  }
  .import {
    flex: 1;
    background: var(--c-ui);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    padding: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .import:hover {
    background: var(--c-ui-hover);
  }
  .add {
    position: relative;
    width: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    border-radius: 5px;
    color: var(--c-tx-muted);
    font-size: 16px;
    cursor: pointer;
  }
  .add input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .hint {
    font-size: 11px;
    opacity: 0.45;
    margin: 4px 0;
  }
  .err {
    color: #f89a8a; /* flexoki red-200 */
    font-size: 11px;
    margin: 6px 0 0;
  }
</style>
