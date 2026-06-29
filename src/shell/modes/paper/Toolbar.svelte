<script lang="ts">
  import Icon from "../../Icon.svelte";
  import type { PaperViewMode } from "./view-mode/paperViewStore";

  let {
    title,
    status,
    viewMode,
    outlineOpen,
    onToggleOutline,
    onSetView,
    // optional, wired in later phases
    onInsert,
    panelOpen = false,
    onTogglePanel,
    commentsOpen = false,
    commentCount = 0,
    onToggleComments,
    previewActive = false,
    onTogglePreview,
    onExport,
  }: {
    title: string;
    status: "demo" | "saved" | "saving";
    viewMode: PaperViewMode;
    outlineOpen: boolean;
    onToggleOutline: () => void;
    onSetView: (m: PaperViewMode) => void;
    onInsert?: (e: MouseEvent) => void;
    panelOpen?: boolean;
    onTogglePanel?: () => void;
    commentsOpen?: boolean;
    commentCount?: number;
    onToggleComments?: () => void;
    previewActive?: boolean;
    onTogglePreview?: () => void;
    onExport?: (e: MouseEvent) => void;
  } = $props();
</script>

<header class="ptoolbar">
  <div class="side">
    <button
      class="tbtn"
      class:on={outlineOpen}
      title="Outline"
      aria-label="Toggle outline"
      onclick={onToggleOutline}>
      <Icon name="panelLeft" size={16} />
    </button>
    <span class="sep"></span>
    <span class="title">{title}</span>
    <span class="status" class:saving={status === "saving"}>
      {#if status === "demo"}demo · not saved{:else if status === "saving"}saving…{:else}saved{/if}
    </span>
  </div>

  <div class="side right">
    {#if onInsert}
      <button class="tbtn" title="Insert…" aria-label="Insert" onclick={onInsert}>
        <Icon name="plus" size={16} />
      </button>
    {/if}
    {#if onTogglePanel}
      <button
        class="tbtn"
        class:on={panelOpen}
        title="Figures & references"
        aria-label="Toggle scholar panel"
        onclick={onTogglePanel}>
        <Icon name="bookOpen" size={16} />
      </button>
    {/if}
    {#if onToggleComments}
      <button
        class="tbtn"
        class:on={commentsOpen}
        title="Comments"
        aria-label="Toggle comments"
        onclick={onToggleComments}>
        <Icon name="message" size={15} />
        {#if commentCount > 0}<span class="badge">{commentCount}</span>{/if}
      </button>
    {/if}
    <span class="sep"></span>
    <div class="seg" role="group" aria-label="View mode">
      <button
        class="segbtn"
        class:on={viewMode === "continuous" && !previewActive}
        title="Continuous"
        onclick={() => onSetView("continuous")}>
        <Icon name="textFlow" size={15} />
      </button>
      <button
        class="segbtn"
        class:on={viewMode === "paginated" && !previewActive}
        title="Pages"
        onclick={() => onSetView("paginated")}>
        <Icon name="page" size={14} />
      </button>
    </div>
    {#if onTogglePreview}
      <button
        class="tbtn"
        class:on={previewActive}
        title="Preview"
        aria-label="Toggle preview"
        onclick={onTogglePreview}>
        <Icon name="eye" size={16} />
      </button>
    {/if}
    {#if onExport}
      <button class="tbtn" title="Export…" aria-label="Export" onclick={onExport}>
        <Icon name="download" size={16} />
      </button>
    {/if}
  </div>
</header>

<style>
  .ptoolbar {
    flex: 0 0 auto;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-3) 0 var(--sp-2);
    border-bottom: 1px solid var(--c-line);
    background: var(--c-bg-raised);
  }
  .side {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    min-width: 0;
  }
  .right {
    gap: 4px;
  }
  .title {
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 36ch;
  }
  .status {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
    white-space: nowrap;
  }
  .status.saving {
    color: var(--c-accent-bright);
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--c-line-strong);
    margin: 0 var(--sp-1);
    flex: 0 0 auto;
  }
  .tbtn {
    position: relative;
    width: 28px;
    height: 26px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-1);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .tbtn:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .tbtn.on {
    color: var(--c-accent-bright);
    background: var(--c-accent-tint-2);
  }
  .badge {
    position: absolute;
    top: -3px;
    right: -3px;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    font-size: 9px;
    line-height: 13px;
    font-family: var(--font-mono);
    border-radius: var(--r-pill);
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .seg {
    display: flex;
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    overflow: hidden;
  }
  .segbtn {
    width: 28px;
    height: 24px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .segbtn:hover {
    color: var(--c-tx);
  }
  .segbtn.on {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
</style>
