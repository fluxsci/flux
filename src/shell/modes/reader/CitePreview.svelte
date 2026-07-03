<script lang="ts">
  // The citation hover card (R4): hover a citation link in the PDF → see WHAT it
  // refers to without scrolling to the bibliography. Structured card when the
  // extracted entry matches an OpenAlex brief from the references sidebar (authors,
  // year, cited-by, + FluxLib, show-in-sidebar); raw extracted text otherwise;
  // external links show their URL. Hovering the card keeps it open (onEnter cancels
  // the parent's hide debounce); ReaderMode owns positioning + matching.
  import type { WorldBrief } from "../../../lib/references/openalex";

  let {
    kind,
    text = "",
    url = "",
    destPage,
    brief = null,
    x,
    y,
    place = "below",
    inLib = false,
    adding = false,
    onAdd,
    onShow,
    onJump,
    onEnter,
    onLeave,
  }: {
    kind: "internal" | "external";
    text?: string;
    url?: string;
    destPage?: number;
    brief?: WorldBrief | null;
    x: number;
    y: number;
    place?: "above" | "below";
    inLib?: boolean;
    adding?: boolean;
    onAdd?: () => void;
    onShow?: () => void;
    onJump?: () => void;
    onEnter?: () => void;
    onLeave?: () => void;
  } = $props();

  const authorsLine = $derived(
    brief ? `${brief.authors.slice(0, 3).join(", ")}${brief.authors.length > 3 ? " et al." : ""}${brief.year ? ` · ${brief.year}` : ""}` : "",
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_mouse_events_have_key_events -->
<div
  class="citecard"
  class:above={place === "above"}
  data-testid="cite-preview"
  style:left="{x}px"
  style:top="{y}px"
  onmouseenter={onEnter}
  onmouseleave={onLeave}
  onmousedown={(e) => e.stopPropagation()}>
  {#if brief}
    <div class="cmeta">
      <span class="cauth">{authorsLine}</span>
      {#if brief.citedByCount != null}<span class="ccite">{brief.citedByCount.toLocaleString()}×</span>{/if}
    </div>
    <div class="ctitle">{brief.title}</div>
    {#if brief.container}<div class="ccontainer">{brief.container}</div>{/if}
    <div class="cactions">
      {#if inLib}
        <span class="cinlib">✓ in library</span>
      {:else if brief.doi}
        <button class="cbtn" disabled={adding} onclick={onAdd}>{adding ? "Adding…" : "+ FluxLib"}</button>
      {/if}
      <button class="cbtn" onclick={onShow}>Show in sidebar</button>
      <span class="spacer"></span>
      {#if destPage}
        <button class="cbtn" title="Jump to the bibliography entry" onclick={onJump}>p.{destPage} →</button>
      {/if}
    </div>
  {:else if kind === "internal"}
    <div class="craw">{text || "…"}</div>
    <div class="cactions">
      <span class="chint">Reference on p.{destPage}</span>
      <span class="spacer"></span>
      {#if destPage}
        <button class="cbtn" onclick={onJump}>p.{destPage} →</button>
      {/if}
    </div>
  {:else}
    <div class="curl">{url}</div>
    <div class="chint">External link — click to open</div>
  {/if}
</div>

<style>
  .citecard {
    position: fixed;
    transform: translate(-50%, 0);
    width: 340px;
    z-index: 55;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 11px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2, 8px);
    box-shadow: var(--elev-2, 0 4px 16px rgba(0, 0, 0, 0.35));
  }
  .citecard.above {
    transform: translate(-50%, -100%);
  }
  .cmeta {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .ccite {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
  .ctitle {
    font-family: var(--font-serif);
    font-size: var(--ts-sm);
    color: var(--c-tx-1);
    line-height: 1.3;
  }
  .ccontainer {
    font-size: var(--ts-xs);
    font-style: italic;
    color: var(--c-tx-2);
  }
  .craw {
    font-family: var(--font-serif);
    font-size: var(--ts-xs);
    color: var(--c-tx-1);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .curl {
    font-size: var(--ts-xs);
    color: var(--c-accent);
    word-break: break-all;
  }
  .chint {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .cactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .cbtn {
    border: 1px solid var(--c-line-strong);
    background: transparent;
    color: var(--c-tx-2);
    border-radius: var(--r-1);
    padding: 2px 8px;
    font: inherit;
    font-size: var(--ts-xs);
    cursor: pointer;
    white-space: nowrap;
  }
  .cbtn:hover:not(:disabled) {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .cinlib {
    font-size: var(--ts-xs);
    color: var(--c-accent);
  }
</style>
