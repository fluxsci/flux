<script lang="ts">
  import ModeContent from "./ModeContent.svelte";
  import Icon from "./Icon.svelte";
  import {
    panes,
    focusPane,
    closePane,
    type Pane,
  } from "./paneStore";
  import type { ModeId } from "./shellStore";

  let { pane, focused }: { pane: Pane; focused: boolean } = $props();

  const LABEL: Record<ModeId, string> = {
    figure: "Figure",
    paper: "Paper",
    slide: "Slide",
    library: "Library",
    reader: "Reader",
  };

  const isSplit = $derived($panes.length > 1);
</script>

<section
  class="pane"
  class:focused={focused && isSplit}
  onpointerdowncapture={() => focusPane(pane.id)}>
  <!-- Single-pane workspaces skip the header entirely (the active title-bar
       mode icon already names the mode; Alt-click a mode icon to split) —
       28px of content height back in the common case. -->
  {#if isSplit}
    <header class="phead">
      <span class="label">{LABEL[pane.mode]}</span>
      <div class="ctrls">
        <button class="pbtn" title="Close pane" onclick={() => closePane(pane.id)}>
          <Icon name="x" size={14} stroke={1.7} />
        </button>
      </div>
    </header>
  {/if}
  <div class="body">
    <ModeContent mode={pane.mode} {focused} />
  </div>
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    position: relative;
  }
  .pane.focused::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 1px solid var(--c-accent-tint);
    box-shadow: inset 0 0 0 1px var(--c-accent-tint-2);
    z-index: 5;
  }
  .phead {
    flex: 0 0 auto;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-2) 0 var(--sp-3);
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
  }
  .label {
    font-size: var(--ts-xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .ctrls {
    display: flex;
    gap: 2px;
  }
  .pbtn {
    width: 24px;
    height: 20px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-1);
    cursor: pointer;
    transition: background var(--dur-instant) var(--ease-standard);
  }
  .pbtn:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background:
      radial-gradient(120% 80% at 50% -10%, var(--c-accent-tint-2), transparent 60%),
      var(--c-bg);
  }
</style>
