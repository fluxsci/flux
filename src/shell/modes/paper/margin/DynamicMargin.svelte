<script lang="ts">
  import Icon from "../../../Icon.svelte";
  import { fadeRise } from "../../../../lib/motion/actions";
  import type { MarginHost, MarginApi } from "./types";
  import { viewById, paneById } from "./registry";
  import Omnibox from "./Omnibox.svelte";
  import ViewRail from "./ViewRail.svelte";

  let {
    host,
    focusReq = 0,
    viewReq,
    onClose,
  }: {
    host: MarginHost;
    focusReq?: number;
    viewReq?: { id: string; n: number };
    onClose: () => void;
  } = $props();

  let activeView = $state("figure");
  let openPanes = $state<{ id: string; initialQuery?: string }[]>([]);

  // PaperMode requests a specific view (e.g. "comments" when commenting) by
  // bumping viewReq.n.
  $effect(() => {
    if (viewReq && viewReq.n > 0) {
      activeView = viewReq.id;
      openPanes = [];
    }
  });

  const margin: MarginApi = {
    get activeView() {
      return activeView;
    },
    setView: (id) => {
      activeView = id;
      openPanes = [];
    },
    openPane: (id, opts) => {
      openPanes = [...openPanes, { id, initialQuery: opts?.initialQuery }];
    },
    closePane: () => {
      openPanes = openPanes.slice(0, -1);
      host.focusEditor();
    },
  };

  const topPane = $derived(openPanes.length ? openPanes[openPanes.length - 1] : null);
  const ActiveView = $derived(viewById(activeView)?.component);
  const TopPane = $derived(topPane ? paneById(topPane.id)?.component : null);
</script>

<aside class="dynmargin" in:fadeRise={{ y: 8 }}>
  <div class="dm-head">
    <Omnibox {host} {margin} {focusReq} />
    <button class="close" onclick={onClose} title="Hide margin (Alt+F)" aria-label="Hide margin">
      <Icon name="panelLeft" size={16} />
    </button>
  </div>
  {#if !topPane}
    <ViewRail {host} {margin} />
  {/if}
  <div class="dm-body">
    {#if topPane && TopPane}
      <TopPane {host} {margin} initialQuery={topPane.initialQuery} />
    {:else if ActiveView}
      <ActiveView {host} {margin} />
    {/if}
  </div>
</aside>

<style>
  .dynmargin {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--c-margin);
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-3);
  }
  .dm-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-3) var(--sp-2);
  }
  .close {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-muted);
    cursor: pointer;
  }
  .close:hover {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
  }
  .dm-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .dm-body > :global(*) {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
