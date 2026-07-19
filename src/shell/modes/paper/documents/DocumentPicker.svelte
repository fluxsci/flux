<script lang="ts">
  // F4: the project's document list, under the Outline in the Paper left rail.
  // Lists every .qmd, highlights the active one, and offers "+ New document".
  import type { DocEntry } from "./documents";

  let {
    docs,
    activePath,
    onSelect,
    onNew,
  }: {
    docs: DocEntry[];
    activePath: string;
    onSelect: (path: string) => void;
    onNew: () => void;
  } = $props();
</script>

<aside class="docpicker">
  <div class="dp-head">Documents</div>
  <ul>
    {#each docs.filter((d) => !d.isContext) as d (d.path)}
      <li>
        <button
          class="dp-item"
          class:active={d.path === activePath}
          title={d.path}
          onclick={() => onSelect(d.path)}>
          <span class="dp-title">{d.title}</span>
          {#if d.isMain}<span class="dp-badge">main</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if docs.some((d) => d.isContext)}
    <div class="dp-head dp-ctx">Context</div>
    <ul>
      {#each docs.filter((d) => d.isContext) as d (d.path)}
        <li>
          <button
            class="dp-item"
            class:active={d.path === activePath}
            title={d.path}
            onclick={() => onSelect(d.path)}>
            <span class="dp-title">{d.title}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <button class="dp-new" onclick={onNew}>+ New document</button>
</aside>

<style>
  .docpicker {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px;
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
    background: var(--flx-paper);
    color: var(--c-tx);
    max-height: 38%;
    overflow: auto;
  }
  .dp-head {
    font-size: var(--ts-xs, 11px);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--c-tx-faint);
    padding: 2px 4px 6px;
  }
  .dp-ctx {
    margin-top: 8px;
    border-top: 1px solid var(--c-line, var(--c-edge));
    padding-top: 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .dp-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--r-1);
    padding: 5px 7px;
    color: var(--c-tx-2);
    font: inherit;
    font-size: var(--ts-sm, 13px);
    cursor: pointer;
  }
  .dp-item:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
  }
  .dp-item.active {
    background: var(--c-ui-hover);
    color: var(--c-tx-hi);
    font-weight: 600;
  }
  .dp-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dp-badge {
    flex: 0 0 auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-accent-bright);
    border: 1px solid var(--c-edge);
    border-radius: var(--r-pill, 999px);
    padding: 0 5px;
  }
  .dp-new {
    margin-top: 6px;
    text-align: left;
    background: none;
    border: 1px dashed var(--c-edge);
    border-radius: var(--r-1);
    padding: 5px 7px;
    color: var(--c-tx-faint);
    font: inherit;
    font-size: var(--ts-sm, 13px);
    cursor: pointer;
  }
  .dp-new:hover {
    color: var(--c-accent-bright);
    border-color: var(--c-accent);
  }
</style>
