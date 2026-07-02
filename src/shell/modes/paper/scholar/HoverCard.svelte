<script lang="ts">
  import { computePosition, offset, flip, shift } from "@floating-ui/dom";
  import { popIn } from "../../../../lib/motion/actions";
  import { fileBridge } from "../../../../lib/project/types";
  import type { ChipTarget } from "../science/chipContext";
  import { resolveFigure, renderFigureSvg, figureRefs } from "./figures";
  import { bibEntry, bibEntries, type BibEntry } from "./bib";
  import { pdfKeys, refreshPdfKeys, hasPdfIn } from "./pdfPresence";

  let {
    target,
    anchor,
    onenter,
    onleave,
    onOpenRef,
    onOpenPdf,
  }: {
    target: ChipTarget;
    anchor: HTMLElement;
    onenter?: () => void;
    onleave?: () => void;
    /** Open this citekey in the References margin view (scrolled + untwirled). */
    onOpenRef?: (key: string) => void;
    /** Open this citekey's full-text PDF in FluxReader. */
    onOpenPdf?: (key: string) => void;
  } = $props();

  // The "Read PDF" pill only shows when the PDF actually exists (throttled
  // stale-while-revalidate readdir — see pdfPresence).
  refreshPdfKeys();

  let card = $state<HTMLDivElement>();
  let x = $state(0);
  let y = $state(0);
  let ready = $state(false);

  // Subscribe to the stores so content updates if data loads after mount.
  const fig = $derived(
    target.kind === "figref" && $figureRefs ? resolveFigure(target.label) : null,
  );
  const figSvg = $derived(fig ? renderFigureSvg(fig.ref.id) : undefined);
  const cites = $derived(
    target.kind === "cite" && $bibEntries
      ? (target.keys.map((k) => bibEntry(k)).filter(Boolean) as BibEntry[])
      : [],
  );

  async function place() {
    if (!card || !anchor) return;
    const pos = await computePosition(anchor, card, {
      placement: "top",
      middleware: [offset(9), flip(), shift({ padding: 10 })],
    });
    x = pos.x;
    y = pos.y;
    ready = true;
  }
  $effect(() => {
    // re-place when target or content changes
    void target;
    void figSvg;
    void cites;
    place();
  });

  function openDoi(doi: string) {
    fileBridge()?.openExternal?.("https://doi.org/" + doi);
  }
</script>

<div
  bind:this={card}
  class="hovercard"
  class:ready
  style="left:{x}px; top:{y}px"
  role="tooltip"
  onmouseenter={onenter}
  onmouseleave={onleave}
  transition:popIn>
  {#if target.kind === "figref"}
    {#if fig}
      <div class="hc-head">
        <span class="hc-num">Figure {fig.number}</span>
        {#if fig.ref.name}<span class="hc-name">{fig.ref.name}</span>{/if}
      </div>
      <div class="hc-fig">
        {#if figSvg}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html figSvg}
        {:else}
          <div class="hc-empty">No preview yet</div>
        {/if}
      </div>
      {#if fig.ref.caption}<p class="hc-cap">{fig.ref.caption}</p>{/if}
      <div class="hc-hint">Click to open in Figure</div>
    {:else}
      <div class="hc-empty">Unknown figure <code>@{target.label}</code></div>
    {/if}
  {:else if target.kind === "cite"}
    {#if cites.length}
      {#each cites as c (c.key)}
        <div class="hc-ref">
          <div class="hc-title">{c.title || c.key}</div>
          <div class="hc-meta">
            {c.authors.join(", ")}{c.year ? " · " + c.year : ""}{c.container
              ? " · " + c.container
              : ""}
          </div>
          <div class="hc-foot">
            {#if c.doi}
              <button class="hc-doi" onclick={() => openDoi(c.doi!)}>
                doi.org/{c.doi}
              </button>
            {/if}
            <code class="hc-key">@{c.key}</code>
          </div>
          {#if onOpenRef || onOpenPdf}
            <div class="hc-actions">
              {#if onOpenRef}
                <button class="hc-pill" onclick={() => onOpenRef(c.key)}>References</button>
              {/if}
              {#if onOpenPdf && hasPdfIn($pdfKeys, c.key)}
                <button class="hc-pill" onclick={() => onOpenPdf(c.key)}>Read PDF</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="hc-empty">Unknown citation</div>
    {/if}
  {/if}
</div>

<style>
  .hovercard {
    position: fixed;
    z-index: 70;
    width: 320px;
    max-width: 80vw;
    padding: var(--sp-3);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    box-shadow: var(--elev-2);
    font-size: var(--ts-sm);
    color: var(--c-tx-2);
    visibility: hidden;
  }
  .hovercard.ready {
    visibility: visible;
  }
  .hc-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .hc-num {
    color: var(--c-accent-bright);
    font-weight: 600;
  }
  .hc-name {
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hc-fig {
    background: var(--flx-paper);
    border-radius: var(--r-1);
    padding: 6px;
    overflow: hidden;
  }
  .hc-fig :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    max-height: 240px;
  }
  .hc-cap {
    margin: var(--sp-2) 0 0;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hc-hint {
    margin-top: var(--sp-2);
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-style: italic;
  }
  .hc-empty {
    color: var(--c-tx-faint);
    font-style: italic;
    padding: var(--sp-2) 0;
  }
  .hc-ref + .hc-ref {
    margin-top: var(--sp-3);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--c-line);
  }
  .hc-title {
    color: var(--c-tx-hi);
    font-weight: 600;
    line-height: 1.35;
    margin-bottom: 3px;
  }
  .hc-meta {
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    line-height: 1.4;
  }
  /* Both children are long unbroken mono tokens (DOI, citekey). Flex items
     default to min-width:auto, so without min-width:0 + overflow-wrap the pair
     can only overflow the card edge — wrap the row and break the tokens. */
  .hc-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 3px var(--sp-2);
    margin-top: var(--sp-2);
  }
  .hc-doi {
    background: none;
    border: none;
    padding: 0;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: left;
    color: var(--c-accent-bright);
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
    cursor: pointer;
    text-decoration: underline;
  }
  .hc-key {
    margin-left: auto;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    text-align: right;
    color: var(--c-tx-faint);
    font-family: var(--font-mono);
    font-size: var(--ts-xs);
  }
  .hc-actions {
    display: flex;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .hc-pill {
    font: inherit;
    font-size: var(--ts-xs);
    line-height: 1.5;
    padding: 1px 10px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    background: var(--c-surface);
    color: var(--c-tx-2);
    cursor: pointer;
  }
  .hc-pill:hover {
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }
</style>
