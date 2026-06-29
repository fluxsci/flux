<script lang="ts">
  import Icon from "../../../Icon.svelte";
  import { VIEWS } from "./registry";
  import type { MarginHost, MarginApi } from "./types";

  let { host, margin }: { host: MarginHost; margin: MarginApi } = $props();

  const views = VIEWS.filter((v) => v.enabled !== false);
</script>

<div class="rail">
  {#each views as v (v.id)}
    {@const badge = v.badge?.(host)}
    <button
      class="tab"
      class:on={margin.activeView === v.id}
      title={v.title}
      onclick={() => margin.setView(v.id)}>
      <Icon name={v.icon} size={17} />
      {#if badge}<span class="badge">{badge}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .rail {
    display: flex;
    gap: 2px;
    padding: var(--sp-2) var(--sp-2) 0;
    border-bottom: 1px solid var(--c-line);
  }
  .tab {
    position: relative;
    flex: 1 1 0;
    display: grid;
    place-items: center;
    height: 34px;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--dur-instant) var(--ease-standard);
  }
  .tab:hover {
    color: var(--c-tx);
  }
  .tab.on {
    color: var(--c-accent);
    border-bottom-color: var(--c-accent);
  }
  .badge {
    position: absolute;
    top: 2px;
    right: calc(50% - 16px);
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    box-sizing: border-box;
    border-radius: 7px;
    background: var(--c-accent);
    color: var(--c-on-accent);
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
  }
</style>
